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
  type: "over_6_5_corners" | "over_7_5_corners" | "over_8_5_corners";
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

export type CornerThresholds = { cornersFloor?: number /* 0..100, default 70 */ };

export function predictCorners(
  analysis: AnyObj,
  homeId?: string,
  awayId?: string,
  thresholds: CornerThresholds = {},
): CornerPrediction[] {
  const cornersFloor = thresholds.cornersFloor ?? 70;
  const d = root(analysis);
  const homeRows = parseRows(d.homeLastMatches);
  const awayRows = parseRows(d.awayLastMatches);
  const h = teamCornerAverages(homeRows, homeId);
  const a = teamCornerAverages(awayRows, awayId);
  if (!h || !a) return [];
  if (h.games < 6 || a.games < 6) return [];

  const projected = (h.cFor + a.cAg + a.cFor + h.cAg) / 2;
  const reasons = [
    `Home avg corners: ${h.cFor.toFixed(2)} for / ${h.cAg.toFixed(2)} against (${h.games} g).`,
    `Away avg corners: ${a.cFor.toFixed(2)} for / ${a.cAg.toFixed(2)} against (${a.games} g).`,
    `Projected total: ${projected.toFixed(2)}.`,
  ];
  const dataPoints = h.games + a.games;

  const out: CornerPrediction[] = [];
  const make = (line: 7.5 | 8.5, projMin: number, type: CornerPrediction["type"], cap: number) => {
    const margin = projected - line;
    let confidence = 50 + margin * 9;
    if (dataPoints < 8) confidence -= 8;
    confidence = Math.max(0, Math.min(cap, confidence));
    if (confidence >= cornersFloor && projected >= projMin) {
      out.push({
        type,
        selection: `Over ${line} Corners`,
        projectedCorners: Math.round(projected * 100) / 100,
        confidence: Math.round(confidence * 10) / 10,
        riskLevel: confidence >= 82 ? "low" : confidence >= 72 ? "medium" : "high",
        reasons,
        stats: { home: h, away: a, projected, line },
      });
    }
  };
  // Run both engines independently — each can qualify on its own.
  make(7.5, 8.0, "over_7_5_corners", 94);
  make(8.5, 9.0, "over_8_5_corners", 92);
  return out;
}

// ---------------- Match outcomes ----------------

export type MatchPrediction = {
  type: "match_winner" | "double_chance" | "asian_handicap" | "over_2_5_goals";
  selection: string;
  confidence: number;
  riskLevel: "low" | "medium" | "high";
  reasons: string[];
  stats: AnyObj;
  // EV fields — populated for match_winner (always, when market odds exist) and for
  // over_2_5_goals (only when the market's own total line is exactly 2.5). Left undefined
  // for double_chance / asian_handicap: no direct bookmaker price exists for those markets
  // in this payload, so no genuine EV can be computed. Do not fabricate a number here.
  modelProbability?: number;
  marketOdds?: number;
  expectedValue?: number;
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

// NOTE: market-odds extraction used to live here, reading from the /analysis payload's
// homeOdds/awayOdds fields and CSV rows. That was wrong on inspection of real cached data:
// /analysis carries no matchId to safely match a row to "this" fixture, and homeOdds/awayOdds
// turned out to be each team's historical per-match odds logs, not a live price for the
// upcoming match. Real, trustworthy live odds now come from /odds/main via
// isports.server.ts's fetchLiveOdds() — fetched once per qualifying match, after threshold
// filtering, and passed in below. This function only ever computes pure model probability;
// EV is attached by the caller once real odds are available.

export type MatchThresholds = {
  winRateFloor?: number;       // 0..1, default 0.45
  drawRateCeil?: number;       // 0..1, default 0.35
  over25Floor?: number;        // 0..100, default 55
  matchWinnerFloor?: number;   // 0..100, default 52
  doubleChanceFloor?: number;  // 0..100, default 65
};

export function predictMatchOutcomes(analysis: AnyObj, homeId?: string, awayId?: string, thresholds: MatchThresholds = {}): MatchPrediction[] {
  const winRateFloor = thresholds.winRateFloor ?? 0.45;
  const drawRateCeil = thresholds.drawRateCeil ?? 0.35;
  const over25Floor = thresholds.over25Floor ?? 55;
  const matchWinnerFloor = thresholds.matchWinnerFloor ?? 52;
  const doubleChanceFloor = thresholds.doubleChanceFloor ?? 65;
  const d = root(analysis);
  const homeRows = parseRows(d.homeLastMatches);
  const awayRows = parseRows(d.awayLastMatches);

  const homeAtHome = dataVsRates(d.homeDataVs, "home") ?? fallbackFromRows(homeRows, homeId);
  const awayAtAway = dataVsRates(d.awayDataVs, "away") ?? fallbackFromRows(awayRows, awayId);
  if (!homeAtHome || !awayAtAway) return [];
  // Require at least 6 games of seasonal data per side before firing.
  if (homeAtHome.count < 6 || awayAtAway.count < 6) return [];

  // Model probabilities. This is now the ONLY input to confidence — no market blend, since
  // the only "market" data available at this stage was proven unreliable (see note above).
  // Real market data gets attached by the caller, post-filter, from a trustworthy source.
  let mH = 0.6 * homeAtHome.winRate + 0.4 * (1 - awayAtAway.winRate - awayAtAway.drawRate);
  let mA = 0.6 * awayAtAway.winRate + 0.4 * (1 - homeAtHome.winRate - homeAtHome.drawRate);
  let mD = 0.5 * (homeAtHome.drawRate + awayAtAway.drawRate);
  mH = Math.max(0.01, mH); mA = Math.max(0.01, mA); mD = Math.max(0.01, mD);
  const mTot = mH + mA + mD;
  mH /= mTot; mA /= mTot; mD /= mTot;
  const pH = mH, pA = mA, pD = mD;

  const out: MatchPrediction[] = [];
  const homeFav = pH >= pA;

  // Match winner threshold (default 52%).
  const winnerConf = Math.round(Math.max(pH, pA) * 1000) / 10;
  const selection = homeFav ? "Home Win" : "Away Win";
  const winnerRecord = homeFav ? homeAtHome : awayAtAway;
  const winnerRecordOk = winnerRecord.winRate >= winRateFloor && winnerRecord.drawRate <= drawRateCeil;
  if (winnerConf >= matchWinnerFloor && winnerRecordOk) {
    // Pure model probability, saved as-is — EV gets computed by the caller once real
    // live odds are fetched (post-threshold-filter, to avoid an extra API call per
    // candidate match that might not even qualify).
    const modelProbability = homeFav ? mH : mA;
    out.push({
      type: "match_winner",
      selection,
      confidence: winnerConf,
      riskLevel: winnerConf >= 70 ? "low" : winnerConf >= 60 ? "medium" : "high",
      reasons: [
        `Home @ home: ${(homeAtHome.winRate * 100).toFixed(0)}% W / ${(homeAtHome.drawRate * 100).toFixed(0)}% D (${homeAtHome.count} g).`,
        `Away @ away: ${(awayAtAway.winRate * 100).toFixed(0)}% W / ${(awayAtAway.drawRate * 100).toFixed(0)}% D (${awayAtAway.count} g).`,
        `Model probability H ${(mH*100).toFixed(0)}% / D ${(mD*100).toFixed(0)}% / A ${(mA*100).toFixed(0)}% (no market blend).`,
        "Live odds checked after filtering — see EV badge if a real market price was found.",
      ],
      stats: { pH, pA, pD, model: { mH, mD, mA } },
      modelProbability,
      // marketOdds/expectedValue intentionally left undefined here — attached later.
    });
  }

  // Double chance and Asian handicap generation removed — no real market price exists for
  // either in this API's data, so no genuine EV can ever be computed for them. Keeping the
  // scanner focused on match_winner and over_1_5_goals, where a real edge can be measured.

  // Goals — Poisson on scored/conceded. Over 2.5 rather than 1.5: 1.5 odds are typically
  // so short (~1.30-1.50) there's little room for real EV even when the model is right.
  const lamH = (homeAtHome.scoredAvg ?? 0) * 0.65 + (awayAtAway.concededAvg ?? 0) * 0.35;
  const lamA = (awayAtAway.scoredAvg ?? 0) * 0.65 + (homeAtHome.concededAvg ?? 0) * 0.35;
  if (lamH > 0 && lamA > 0) {
    // P(total <= 2) — every (home goals, away goals) combination summing to 0, 1, or 2.
    const p00 = poissonP(0, lamH) * poissonP(0, lamA);
    const p10 = poissonP(1, lamH) * poissonP(0, lamA);
    const p01 = poissonP(0, lamH) * poissonP(1, lamA);
    const p20 = poissonP(2, lamH) * poissonP(0, lamA);
    const p11 = poissonP(1, lamH) * poissonP(1, lamA);
    const p02 = poissonP(0, lamH) * poissonP(2, lamA);
    const pOver25 = Math.max(0, 1 - p00 - p10 - p01 - p20 - p11 - p02);
    const ov25 = Math.round(pOver25 * 1000) / 10;
    if (ov25 >= over25Floor) {
      // Pure Poisson probability, saved as-is — EV gets computed by the caller once real
      // live odds are fetched (post-threshold-filter), and only when a bookmaker is found
      // quoting exactly a 2.5 total line.
      const modelProbability = pOver25;
      out.push({
        type: "over_2_5_goals",
        selection: "Over 2.5 Goals",
        confidence: Math.min(96, ov25),
        riskLevel: ov25 >= 85 ? "low" : "medium",
        reasons: [
          `λ home ${lamH.toFixed(2)}, λ away ${lamA.toFixed(2)} — Poisson P(3+) = ${ov25.toFixed(1)}%.`,
          "Live odds checked after filtering — see EV badge if a bookmaker quoting exactly 2.5 was found.",
        ],
        stats: { lamH, lamA, pOver25 },
        modelProbability,
        // marketOdds/expectedValue intentionally left undefined here — attached later.
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
  if (predictionType === "over_8_5_corners") return cornersOk ? corners > 8.5 : null;
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
// Lowered to surface 30-50 investable picks per scan; sliders can override.
export const CONFIDENCE_THRESHOLDS: Record<string, number> = {
  match_winner: 52,
  double_chance: 65,
  asian_handicap: 70,
  over_2_5_goals: 55,
  over_1_5_goals: 60, // legacy — kept so old rows/analytics referencing this type still resolve.
  over_6_5_corners: 65,
  over_7_5_corners: 68,
  over_8_5_corners: 72,
};

export function meetsConfidenceThreshold(type: string, confidence: number): boolean {
  const t = CONFIDENCE_THRESHOLDS[type] ?? 75;
  return Number(confidence) >= t;
}
