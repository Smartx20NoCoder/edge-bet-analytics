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

// ---------------- Recency-weighted form ----------------
// dataVsRates (the API's own home/away split) is a pre-aggregated black box — no per-game
// timestamps inside it, so it can't be reweighted. This computes an independent signal
// straight from the individual per-game CSV rows (which DO have per-game timestamps),
// weighting recent games higher via exponential decay. Blended into the base model below,
// never replacing it, and only when enough individual games are actually available.
function recencyWeightedStats(rows: Row[], teamId: string | undefined, halfLifeGames = 8) {
  const games: { t: number; my: number; opp: number }[] = [];
  for (const r of rows) {
    const hs = n(r[COL.scoreHome]), as = n(r[COL.scoreAway]), t = n(r[COL.matchTime]);
    if (hs === undefined || as === undefined || t === undefined) continue;
    const isHome = teamId && r[COL.homeTeamId] === String(teamId);
    const isAway = teamId && r[COL.awayTeamId] === String(teamId);
    if (!isHome && !isAway) continue;
    games.push({ t, my: isHome ? hs : as, opp: isHome ? as : hs });
  }
  if (games.length < 6) return undefined; // not enough individual games to trust this signal
  games.sort((a, b) => b.t - a.t); // most recent first

  let wSum = 0, winW = 0, drawW = 0, loseW = 0, scoredW = 0, concededW = 0;
  games.forEach((g, i) => {
    const w = Math.pow(0.5, i / halfLifeGames);
    wSum += w;
    if (g.my > g.opp) winW += w;
    else if (g.my === g.opp) drawW += w;
    else loseW += w;
    scoredW += g.my * w;
    concededW += g.opp * w;
  });
  return {
    count: games.length,
    winRate: winW / wSum,
    drawRate: drawW / wSum,
    loseRate: loseW / wSum,
    scoredAvg: scoredW / wSum,
    concededAvg: concededW / wSum,
  };
}

// ---------------- Head-to-head ----------------
// Real prior meetings between these exact two teams. Weight scales with how many meetings
// exist (capped) — one past meeting shouldn't move the needle much, six or more should.
function headToHeadStats(rows: Row[], homeId: string | undefined, awayId: string | undefined) {
  if (!homeId || !awayId) return undefined;
  let count = 0, homeWin = 0, draw = 0, awayWin = 0, totalGoals = 0;
  for (const r of rows) {
    const hs = n(r[COL.scoreHome]), as = n(r[COL.scoreAway]);
    if (hs === undefined || as === undefined) continue;
    const rowHomeId = r[COL.homeTeamId], rowAwayId = r[COL.awayTeamId];
    // This past meeting must be between exactly these two teams, in either venue direction.
    const currentHomeWasHome = rowHomeId === String(homeId) && rowAwayId === String(awayId);
    const currentHomeWasAway = rowHomeId === String(awayId) && rowAwayId === String(homeId);
    if (!currentHomeWasHome && !currentHomeWasAway) continue;
    count++;
    totalGoals += hs + as;
    // Normalize to "current home team"'s perspective regardless of which side they were on.
    const myScore = currentHomeWasHome ? hs : as;
    const oppScore = currentHomeWasHome ? as : hs;
    if (myScore > oppScore) homeWin++;
    else if (myScore === oppScore) draw++;
    else awayWin++;
  }
  if (!count) return undefined;
  return {
    count,
    homeWinRate: homeWin / count, // "home" = the team that is home in THIS upcoming fixture
    drawRate: draw / count,
    awayWinRate: awayWin / count,
    avgTotalGoals: totalGoals / count,
  };
}

// ---------------- League rank ----------------
// Schedule payload's homeRank/awayRank are sometimes plain numbers ("15") and sometimes
// league-prefixed ("MEX Lig2C-15", "PER L1A-11") — pull the trailing number either way.
function parseRank(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = String(raw).trim().match(/(\d+)\s*$/);
  if (!m) return undefined;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : undefined;
}

export type MatchThresholds = {
  winRateFloor?: number;       // 0..1, default 0.45
  drawRateCeil?: number;       // 0..1, default 0.35
  over25Floor?: number;        // 0..100, default 55
  matchWinnerFloor?: number;   // 0..100, default 49
  doubleChanceFloor?: number;  // 0..100, default 65
};

export function predictMatchOutcomes(
  analysis: AnyObj,
  homeId?: string,
  awayId?: string,
  thresholds: MatchThresholds = {},
  homeRankRaw?: string,
  awayRankRaw?: string,
): MatchPrediction[] {
  const winRateFloor = thresholds.winRateFloor ?? 0.45;
  const drawRateCeil = thresholds.drawRateCeil ?? 0.35;
  const over25Floor = thresholds.over25Floor ?? 55;
  const matchWinnerFloor = thresholds.matchWinnerFloor ?? 49;
  const doubleChanceFloor = thresholds.doubleChanceFloor ?? 65;
  const d = root(analysis);
  const homeRows = parseRows(d.homeLastMatches);
  const awayRows = parseRows(d.awayLastMatches);
  const h2hRows = parseRows(d.headToHead);

  const homeAtHome = dataVsRates(d.homeDataVs, "home") ?? fallbackFromRows(homeRows, homeId);
  const awayAtAway = dataVsRates(d.awayDataVs, "away") ?? fallbackFromRows(awayRows, awayId);
  if (!homeAtHome || !awayAtAway) return [];
  // Require at least 6 games of seasonal data per side before firing.
  if (homeAtHome.count < 6 || awayAtAway.count < 6) return [];

  // ---- Base model (unchanged formula) ----
  let mH = 0.6 * homeAtHome.winRate + 0.4 * (1 - awayAtAway.winRate - awayAtAway.drawRate);
  let mA = 0.6 * awayAtAway.winRate + 0.4 * (1 - homeAtHome.winRate - homeAtHome.drawRate);
  let mD = 0.5 * (homeAtHome.drawRate + awayAtAway.drawRate);
  mH = Math.max(0.01, mH); mA = Math.max(0.01, mA); mD = Math.max(0.01, mD);
  const mTot = mH + mA + mD;
  mH /= mTot; mA /= mTot; mD /= mTot;

  // ---- Ensemble: blend in recency, H2H, and rank signals, each weighted by how much real
  // data backs them. This never overrides the base model — it's a weighted average, so a
  // signal with little/no data behind it just contributes ~0 and the base model dominates. ----
  const signals: { w: number; H: number; D: number; A: number }[] = [{ w: 1.0, H: mH, D: mD, A: mA }];
  const reasonsExtra: string[] = [];

  const homeRecency = recencyWeightedStats(homeRows, homeId);
  const awayRecency = recencyWeightedStats(awayRows, awayId);
  if (homeRecency && awayRecency) {
    let rH = 0.6 * homeRecency.winRate + 0.4 * (1 - awayRecency.winRate - awayRecency.drawRate);
    let rA = 0.6 * awayRecency.winRate + 0.4 * (1 - homeRecency.winRate - homeRecency.drawRate);
    let rD = 0.5 * (homeRecency.drawRate + awayRecency.drawRate);
    rH = Math.max(0.01, rH); rA = Math.max(0.01, rA); rD = Math.max(0.01, rD);
    const rTot = rH + rA + rD;
    signals.push({ w: 0.35, H: rH / rTot, D: rD / rTot, A: rA / rTot });
    reasonsExtra.push(`Recency-weighted form (last ${homeRecency.count}/${awayRecency.count} games, recent games weighted higher): H ${(rH/rTot*100).toFixed(0)}% / D ${(rD/rTot*100).toFixed(0)}% / A ${(rA/rTot*100).toFixed(0)}%.`);
  }

  const h2h = headToHeadStats(h2hRows, homeId, awayId);
  if (h2h) {
    const h2hWeight = Math.min(0.30, h2h.count * 0.05);
    signals.push({ w: h2hWeight, H: h2h.homeWinRate, D: h2h.drawRate, A: h2h.awayWinRate });
    reasonsExtra.push(`Head-to-head (${h2h.count} past meeting${h2h.count === 1 ? "" : "s"}): ${(h2h.homeWinRate*100).toFixed(0)}% / ${(h2h.drawRate*100).toFixed(0)}% / ${(h2h.awayWinRate*100).toFixed(0)}%, avg ${h2h.avgTotalGoals.toFixed(1)} goals/meeting.`);
  }

  const homeRank = parseRank(homeRankRaw);
  const awayRank = parseRank(awayRankRaw);
  if (homeRank !== undefined && awayRank !== undefined) {
    const gap = awayRank - homeRank; // positive = home ranked better (lower number = higher table position)
    const tilt = Math.max(-0.35, Math.min(0.35, gap / 40));
    const rankPHomeNonDraw = 0.5 + tilt;
    signals.push({ w: 0.20, H: rankPHomeNonDraw * (1 - mD), D: mD, A: (1 - rankPHomeNonDraw) * (1 - mD) });
    reasonsExtra.push(`League rank: Home #${homeRank} vs Away #${awayRank}${gap !== 0 ? ` (${gap > 0 ? "home" : "away"} placed higher)` : " (level)"}.`);
  }

  const totalW = signals.reduce((s, x) => s + x.w, 0);
  const pH = signals.reduce((s, x) => s + x.w * x.H, 0) / totalW;
  const pD = signals.reduce((s, x) => s + x.w * x.D, 0) / totalW;
  const pA = signals.reduce((s, x) => s + x.w * x.A, 0) / totalW;

  const out: MatchPrediction[] = [];
  const homeFav = pH >= pA;

  // Match winner threshold (default 49%).
  const winnerConf = Math.round(Math.max(pH, pA) * 1000) / 10;
  const selection = homeFav ? "Home Win" : "Away Win";
  const winnerRecord = homeFav ? homeAtHome : awayAtAway;
  const winnerRecordOk = winnerRecord.winRate >= winRateFloor && winnerRecord.drawRate <= drawRateCeil;
  if (winnerConf >= matchWinnerFloor && winnerRecordOk) {
    // Ensemble probability, saved as-is — EV gets computed by the caller once real
    // live odds are fetched (post-threshold-filter, to avoid an extra API call per
    // candidate match that might not even qualify).
    const modelProbability = homeFav ? pH : pA;
    out.push({
      type: "match_winner",
      selection,
      confidence: winnerConf,
      riskLevel: winnerConf >= 70 ? "low" : winnerConf >= 60 ? "medium" : "high",
      reasons: [
        `Home @ home: ${(homeAtHome.winRate * 100).toFixed(0)}% W / ${(homeAtHome.drawRate * 100).toFixed(0)}% D (${homeAtHome.count} g).`,
        `Away @ away: ${(awayAtAway.winRate * 100).toFixed(0)}% W / ${(awayAtAway.drawRate * 100).toFixed(0)}% D (${awayAtAway.count} g).`,
        `Base model H ${(mH*100).toFixed(0)}% / D ${(mD*100).toFixed(0)}% / A ${(mA*100).toFixed(0)}%.`,
        ...reasonsExtra,
        `Ensemble (all signals blended): H ${(pH*100).toFixed(0)}% / D ${(pD*100).toFixed(0)}% / A ${(pA*100).toFixed(0)}%.`,
        "Live odds checked after filtering — see EV badge if a real market price was found.",
      ],
      stats: { pH, pA, pD, base: { mH, mD, mA }, signalsUsed: signals.length },
      modelProbability,
      // marketOdds/expectedValue intentionally left undefined here — attached later.
    });
  }

  // Double chance and Asian handicap generation removed — no real market price exists for
  // either in this API's data, so no genuine EV can ever be computed for them. Keeping the
  // scanner focused on match_winner and over_2_5_goals, where a real edge can be measured.

  // Goals — Poisson on scored/conceded, blended with recency-weighted scoring/conceding
  // and nudged toward this exact matchup's own head-to-head scoring history.
  let lamH = (homeAtHome.scoredAvg ?? 0) * 0.65 + (awayAtAway.concededAvg ?? 0) * 0.35;
  let lamA = (awayAtAway.scoredAvg ?? 0) * 0.65 + (homeAtHome.concededAvg ?? 0) * 0.35;
  const goalsReasonsExtra: string[] = [];
  if (homeRecency && awayRecency && homeRecency.scoredAvg !== undefined && awayRecency.scoredAvg !== undefined) {
    const rLamH = homeRecency.scoredAvg * 0.65 + (awayRecency.concededAvg ?? 0) * 0.35;
    const rLamA = awayRecency.scoredAvg * 0.65 + (homeRecency.concededAvg ?? 0) * 0.35;
    lamH = 0.65 * lamH + 0.35 * rLamH;
    lamA = 0.65 * lamA + 0.35 * rLamA;
    goalsReasonsExtra.push(`Recency-weighted λ: home ${rLamH.toFixed(2)}, away ${rLamA.toFixed(2)} (blended in).`);
  }
  if (h2h && h2h.count >= 2) {
    const h2hGoalsWeight = Math.min(0.25, h2h.count * 0.04);
    const currentTotal = lamH + lamA;
    if (currentTotal > 0) {
      const targetTotal = (1 - h2hGoalsWeight) * currentTotal + h2hGoalsWeight * h2h.avgTotalGoals;
      const scale = targetTotal / currentTotal;
      lamH *= scale; lamA *= scale;
      goalsReasonsExtra.push(`H2H avg ${h2h.avgTotalGoals.toFixed(1)} goals/meeting (${h2h.count} meetings) nudged total λ toward ${targetTotal.toFixed(2)}.`);
    }
  }
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
      // Ensemble Poisson probability, saved as-is — EV gets computed by the caller once
      // real live odds are fetched (post-threshold-filter), and only when a bookmaker is
      // found quoting exactly a 2.5 total line.
      const modelProbability = pOver25;
      out.push({
        type: "over_2_5_goals",
        selection: "Over 2.5 Goals",
        confidence: Math.min(96, ov25),
        riskLevel: ov25 >= 85 ? "low" : "medium",
        reasons: [
          `λ home ${lamH.toFixed(2)}, λ away ${lamA.toFixed(2)} — Poisson P(3+) = ${ov25.toFixed(1)}%.`,
          ...goalsReasonsExtra,
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
  if (predictionType === "match_winner_hedged") {
    // Real +0.5 Asian Handicap — win or draw for the picked side, no push possible.
    if (selection.startsWith("Home")) return hs >= as;
    return as >= hs;
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
