// Statistical prediction engines. Server-only.
// Parses the actual iSportsAPI /analysis response shape:
//   { code, data: { homeLastMatches, awayLastMatches, headToHead,
//                   homeGoals, awayGoals, homeDataVs, awayDataVs,
//                   homeOdds, awayOdds, homeSingleDouble, awaySingleDouble, ... } }
// Each *LastMatches/headToHead row is a CSV string.

type AnyObj = Record<string, any>;

// CSV column indices per iSports docs.
const COL = {
  matchId: 0, league: 1, leagueId: 2, matchTime: 3,
  home: 4, homeTeamId: 5, away: 6, awayTeamId: 7,
  scoreHome: 8, scoreAway: 9, homeHalfScore: 10, awayHalfScore: 11,
  homeRed: 12, awayRed: 13, homeCorner: 14, awayCorner: 15,
  initialHandicapHome: 16, initialHandicap: 17, initialHandicapAway: 18,
  instantHandicapHome: 19, instantHandicap: 20, instantHandicapAway: 21,
  initialHome: 22, initialDraw: 23, initialAway: 24,
  instantHome: 25, instantDraw: 26, instantAway: 27,
  initialOver: 28, initialTotal: 29, initialUnder: 30,
  instantOver: 31, instantTotal: 32, instantUnder: 33,
} as const;

function n(v: any): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const x = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(x) ? x : undefined;
}

type Row = string[];
function parseRows(arr: any): Row[] {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((r) => (typeof r === "string" ? r.split(",").map((s) => s.trim()) : Array.isArray(r) ? r.map(String) : null))
    .filter((r): r is Row => Array.isArray(r) && r.length >= 16);
}

function root(analysis: AnyObj): AnyObj {
  // iSports wraps payload under .data; tolerate both shapes.
  return analysis?.data && typeof analysis.data === "object" ? analysis.data : analysis ?? {};
}

// ---------------- Corners ----------------

export type CornerPrediction = {
  type: "over_6_5_corners" | "over_7_5_corners";
  selection: string;
  projectedCorners: number;
  confidence: number;
  riskLevel: "low" | "medium" | "high";
  reasons: string[];
  stats: AnyObj;
};

function teamCornerAverages(rows: Row[], teamId: string | undefined) {
  let games = 0, cFor = 0, cAg = 0;
  for (const r of rows) {
    const hC = n(r[COL.homeCorner]);
    const aC = n(r[COL.awayCorner]);
    if (hC === undefined || aC === undefined) continue;
    const isHome = teamId && r[COL.homeTeamId] === String(teamId);
    const isAway = teamId && r[COL.awayTeamId] === String(teamId);
    if (!isHome && !isAway) continue;
    games++;
    if (isHome) { cFor += hC; cAg += aC; } else { cFor += aC; cAg += hC; }
  }
  if (games) return { games, cFor: cFor / games, cAg: cAg / games };

  // Fallback: team IDs didn't match — pool all rows generically.
  let pooled = 0, total = 0;
  for (const r of rows) {
    const hC = n(r[COL.homeCorner]);
    const aC = n(r[COL.awayCorner]);
    if (hC === undefined || aC === undefined) continue;
    pooled++; total += hC + aC;
  }
  if (!pooled) return undefined;
  const mid = total / pooled / 2;
  return { games: pooled, cFor: mid, cAg: mid };
}

export function predictCorners(analysis: AnyObj, homeId?: string, awayId?: string): CornerPrediction[] {
  const d = root(analysis);
  const homeRows = parseRows(d.homeLastMatches);
  const awayRows = parseRows(d.awayLastMatches);
  const h = teamCornerAverages(homeRows, homeId);
  const a = teamCornerAverages(awayRows, awayId);
  if (!h || !a) return [];
  // Require at least 6 games of seasonal data per side before firing.
  if (h.games < 6 || a.games < 6) return [];

  const projected = (h.cFor + a.cAg + a.cFor + h.cAg) / 2;
  const reasons = [
    `Home avg corners: ${h.cFor.toFixed(2)} for / ${h.cAg.toFixed(2)} against (${h.games} g).`,
    `Away avg corners: ${a.cFor.toFixed(2)} for / ${a.cAg.toFixed(2)} against (${a.games} g).`,
    `Projected total: ${projected.toFixed(2)}.`,
  ];
  const dataPoints = h.games + a.games;

  const out: CornerPrediction[] = [];
  const make = (line: 6.5 | 7.5, projMin: number) => {
    const margin = projected - line;
    let confidence = 50 + margin * 9;
    if (dataPoints < 8) confidence -= 8;
    confidence = Math.max(0, Math.min(line === 6.5 ? 96 : 94, confidence));
    if (confidence >= 75 && projected >= projMin) {
      out.push({
        type: line === 6.5 ? "over_6_5_corners" : "over_7_5_corners",
        selection: `Over ${line} Corners`,
        projectedCorners: Math.round(projected * 100) / 100,
        confidence: Math.round(confidence * 10) / 10,
        riskLevel: confidence >= 85 ? "low" : confidence >= 75 ? "medium" : "high",
        reasons,
        stats: { home: h, away: a, projected },
      });
    }
  };
  make(6.5, 7.5);
  make(7.5, 8.5);
  return out;
}

// ---------------- Match outcomes ----------------

export type MatchPrediction = {
  type: "match_winner" | "double_chance" | "asian_handicap" | "over_1_5_goals";
  selection: string;
  confidence: number;
  riskLevel: "low" | "medium" | "high";
  reasons: string[];
  stats: AnyObj;
};

function dataVsRates(side: AnyObj | undefined, scope: "home" | "away" | "total") {
  const s = side?.[scope];
  if (!s) return undefined;
  const count = n(s.count);
  if (!count || count <= 0) return undefined;
  const win = n(s.win) ?? 0, draw = n(s.draw) ?? 0, lose = n(s.lose) ?? 0;
  const scored = n(s.scored), conceded = n(s.conceded);
  return {
    count,
    winRate: win / count,
    drawRate: draw / count,
    loseRate: lose / count,
    scoredAvg: scored !== undefined ? scored / count : undefined,
    concededAvg: conceded !== undefined ? conceded / count : undefined,
  };
}

function fallbackFromRows(rows: Row[], teamId: string | undefined) {
  let games = 0, scored = 0, conceded = 0, win = 0, draw = 0, lose = 0;
  for (const r of rows) {
    const hs = n(r[COL.scoreHome]), as = n(r[COL.scoreAway]);
    if (hs === undefined || as === undefined) continue;
    const isHome = teamId && r[COL.homeTeamId] === String(teamId);
    const isAway = teamId && r[COL.awayTeamId] === String(teamId);
    if (!isHome && !isAway) continue;
    games++;
    const my = isHome ? hs : as;
    const opp = isHome ? as : hs;
    scored += my; conceded += opp;
    if (my > opp) win++; else if (my === opp) draw++; else lose++;
  }
  if (!games) return undefined;
  return {
    count: games,
    winRate: win / games,
    drawRate: draw / games,
    loseRate: lose / games,
    scoredAvg: scored / games,
    concededAvg: conceded / games,
  };
}

function poissonP(k: number, lambda: number) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let f = 1;
  for (let i = 2; i <= k; i++) f *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / f;
}

// Extract fair (overround-removed) market probabilities for H/D/A from the analysis payload.
function extractMarketProbs(analysis: AnyObj): { pH: number; pD: number; pA: number; oH: number; oD: number; oA: number } | undefined {
  const d = root(analysis);

  // Try CSV homeOdds / awayOdds rows first (each row is a CSV with columns matching home/away last matches).
  // Top-level fields can also be a row of [home, draw, away] for the upcoming match.
  const tryTriple = (h: any, dr: any, a: any) => {
    const oH = n(h), oD = n(dr), oA = n(a);
    if (!oH || !oD || !oA || oH < 1.01 || oD < 1.01 || oA < 1.01) return undefined;
    const iH = 1 / oH, iD = 1 / oD, iA = 1 / oA;
    const s = iH + iD + iA;
    return { pH: iH / s, pD: iD / s, pA: iA / s, oH, oD, oA };
  };

  // Direct top-level fields some payloads expose.
  const direct = tryTriple(d.homeOdds, d.drawOdds, d.awayOdds)
    ?? tryTriple(d.oddsHome, d.oddsDraw, d.oddsAway);
  if (direct) return direct;

  // Pull pre-match odds from any *LastMatches CSV row whose matchId matches d.matchId, else fall back
  // to averaging the most recent row instant odds. Most reliable: the analysis CSV column layout has
  // initialHome/Draw/Away at COL.initialHome..initialAway.
  const allRows: Row[] = [
    ...parseRows(d.homeLastMatches),
    ...parseRows(d.awayLastMatches),
    ...parseRows(d.headToHead),
  ];
  const targetId = d.matchId ? String(d.matchId) : undefined;
  for (const r of allRows) {
    if (targetId && r[COL.matchId] !== targetId) continue;
    const t = tryTriple(r[COL.initialHome], r[COL.initialDraw], r[COL.initialAway])
      ?? tryTriple(r[COL.instantHome], r[COL.instantDraw], r[COL.instantAway]);
    if (t) return t;
  }
  return undefined;
}

export function predictMatchOutcomes(analysis: AnyObj, homeId?: string, awayId?: string): MatchPrediction[] {
  const d = root(analysis);
  const homeRows = parseRows(d.homeLastMatches);
  const awayRows = parseRows(d.awayLastMatches);

  const homeAtHome = dataVsRates(d.homeDataVs, "home") ?? fallbackFromRows(homeRows, homeId);
  const awayAtAway = dataVsRates(d.awayDataVs, "away") ?? fallbackFromRows(awayRows, awayId);
  if (!homeAtHome || !awayAtAway) return [];
  // Require at least 6 games of seasonal data per side before firing.
  if (homeAtHome.count < 6 || awayAtAway.count < 6) return [];

  // Model probabilities.
  let mH = 0.6 * homeAtHome.winRate + 0.4 * (1 - awayAtAway.winRate - awayAtAway.drawRate);
  let mA = 0.6 * awayAtAway.winRate + 0.4 * (1 - homeAtHome.winRate - homeAtHome.drawRate);
  let mD = 0.5 * (homeAtHome.drawRate + awayAtAway.drawRate);
  mH = Math.max(0.01, mH); mA = Math.max(0.01, mA); mD = Math.max(0.01, mD);
  const mTot = mH + mA + mD;
  mH /= mTot; mA /= mTot; mD /= mTot;

  // Market probabilities (overround-removed).
  const market = extractMarketProbs(analysis);
  const blendW = market ? 0.45 : 0;
  const pH = (1 - blendW) * mH + blendW * (market?.pH ?? 0);
  const pA = (1 - blendW) * mA + blendW * (market?.pA ?? 0);
  const pD = (1 - blendW) * mD + blendW * (market?.pD ?? 0);

  const out: MatchPrediction[] = [];
  const homeFav = pH >= pA;
  const modelHomeFav = mH >= mA;
  const marketHomeFav = market ? market.pH >= market.pA : homeFav;
  const agree = !market || modelHomeFav === marketHomeFav;

  const marketReason = market
    ? `Market odds H ${market.oH.toFixed(2)} / D ${market.oD.toFixed(2)} / A ${market.oA.toFixed(2)} → fair P ${(market.pH*100).toFixed(0)}/${(market.pD*100).toFixed(0)}/${(market.pA*100).toFixed(0)}%.`
    : "No bookie odds available — model-only.";

  // NOTE: this gate (57) MUST stay in sync with CONFIDENCE_THRESHOLDS.match_winner
  // in this file. If you change one, change the other.
  const rawWinnerConf = Math.round(Math.max(pH, pA) * 1000) / 10;
  // Disagreement between model and market doesn't drop the pick — it costs 5 confidence points.
  const winnerConf = agree ? rawWinnerConf : Math.max(0, Math.round((rawWinnerConf - 5) * 10) / 10);
  const selection = homeFav ? "Home Win" : "Away Win";
  // Quality gate: only the predicted winner's seasonal record must clear the bar.
  const winnerRecord = homeFav ? homeAtHome : awayAtAway;
  const winnerRecordOk = winnerRecord.winRate >= 0.57 && winnerRecord.drawRate <= 0.25;
  if (winnerConf >= 57 && winnerRecordOk) {
    out.push({
      type: "match_winner",
      selection,
      confidence: winnerConf,
      riskLevel: winnerConf >= 80 ? "low" : winnerConf >= 70 ? "medium" : "high",
      reasons: [
        `Home @ home: ${(homeAtHome.winRate * 100).toFixed(0)}% W / ${(homeAtHome.drawRate * 100).toFixed(0)}% D (${homeAtHome.count} g).`,
        `Away @ away: ${(awayAtAway.winRate * 100).toFixed(0)}% W / ${(awayAtAway.drawRate * 100).toFixed(0)}% D (${awayAtAway.count} g).`,
        marketReason,
        agree ? "Model and market agree on the favourite." : "⚠️ Model and market disagree on the favourite — confidence penalised by 5 pts.",
      ],
      stats: { pH, pA, pD, model: { mH, mD, mA }, market, agree },
    });
  }

  const dcConf = Math.round((homeFav ? pH + pD : pA + pD) * 1000) / 10;
  if (dcConf >= 75 && agree) {
    out.push({
      type: "double_chance",
      selection: homeFav ? "Home or Draw (1X)" : "Draw or Away (X2)",
      confidence: Math.min(95, dcConf),
      riskLevel: dcConf >= 80 ? "low" : "medium",
      reasons: [`Combined blended probability ${dcConf.toFixed(1)}%.`, marketReason],
      stats: { pH, pA, pD, market },
    });
  }

  // Asian handicap based on blended edge.
  const edge = Math.abs(pH - pA);
  if (edge >= 0.18 && agree) {
    const ahConf = Math.round(Math.min(90, 65 + edge * 100) * 10) / 10;
    if (ahConf >= 75) {
      out.push({
        type: "asian_handicap",
        selection: homeFav ? "Home -0.25 AH" : "Away -0.25 AH",
        confidence: ahConf,
        riskLevel: ahConf >= 82 ? "low" : "medium",
        reasons: [`Blended probability gap ${(edge * 100).toFixed(0)} pts justifies a quarter-line.`, marketReason],
        stats: { edge, pH, pA, market },
      });
    }
  }

  // Goals — Poisson on scored/conceded.
  const lamH = (homeAtHome.scoredAvg ?? 0) * 0.65 + (awayAtAway.concededAvg ?? 0) * 0.35;
  const lamA = (awayAtAway.scoredAvg ?? 0) * 0.65 + (homeAtHome.concededAvg ?? 0) * 0.35;
  if (lamH > 0 && lamA > 0) {
    const p00 = poissonP(0, lamH) * poissonP(0, lamA);
    const p10 = poissonP(1, lamH) * poissonP(0, lamA);
    const p01 = poissonP(0, lamH) * poissonP(1, lamA);
    const pOver15 = Math.max(0, 1 - p00 - p10 - p01);
    const ov15 = Math.round(pOver15 * 1000) / 10;
    if (ov15 >= 75) {
      out.push({
        type: "over_1_5_goals",
        selection: "Over 1.5 Goals",
        confidence: Math.min(96, ov15),
        riskLevel: ov15 >= 85 ? "low" : "medium",
        reasons: [`λ home ${lamH.toFixed(2)}, λ away ${lamA.toFixed(2)} — Poisson P(2+) = ${ov15.toFixed(1)}%.`],
        stats: { lamH, lamA, pOver15 },
      });
    }

  }

  return out;
}

// ---------------- Grading ----------------

export function gradePrediction(
  predictionType: string,
  selection: string,
  r: { homeScore: number | null; awayScore: number | null; homeCorners: number | null; awayCorners: number | null },
): boolean | null {
  const hs = r.homeScore, as = r.awayScore;
  const corners = (r.homeCorners ?? 0) + (r.awayCorners ?? 0);
  const cornersOk = r.homeCorners != null && r.awayCorners != null;
  if (predictionType === "over_6_5_corners") return cornersOk ? corners > 6.5 : null;
  if (predictionType === "over_7_5_corners") return cornersOk ? corners > 7.5 : null;
  if (hs == null || as == null) return null;
  if (predictionType === "over_1_5_goals") return hs + as > 1.5;
  if (predictionType === "over_2_5_goals") return hs + as > 2.5;
  if (predictionType === "btts") return hs > 0 && as > 0;
  if (predictionType === "match_winner") {
    if (selection.startsWith("Home")) return hs > as;
    return as > hs;
  }
  if (predictionType === "double_chance") {
    if (selection.includes("1X")) return hs >= as;
    return as >= hs;
  }
  if (predictionType === "asian_handicap") {
    if (selection.startsWith("Home")) return hs > as;
    return as > hs;
  }
  return null;
}

// Confidence thresholds enforced before saving any prediction.
export const CONFIDENCE_THRESHOLDS: Record<string, number> = {
  match_winner: 57,
  double_chance: 75,
  asian_handicap: 75,
  over_1_5_goals: 75,
  over_6_5_corners: 75,
  over_7_5_corners: 75,
};

export function meetsConfidenceThreshold(type: string, confidence: number): boolean {
  const t = CONFIDENCE_THRESHOLDS[type] ?? 75;
  return Number(confidence) >= t;
}
