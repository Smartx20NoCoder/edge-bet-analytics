// Statistical prediction engines. Server-only.
// Defensive parsing: iSportsAPI analysis payloads vary by league/match.
// We only emit predictions when underlying data is present — never fabricate.

type AnyObj = Record<string, any>;

function num(v: any): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "string" ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Walk an object and grab the first numeric value matching any key (case-insensitive substring).
function findNum(obj: AnyObj | undefined, keys: string[]): number | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const lower = keys.map((k) => k.toLowerCase());
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (lower.some((needle) => lk.includes(needle))) {
      const n = num(v);
      if (n !== undefined) return n;
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const n = findNum(v as AnyObj, keys);
      if (n !== undefined) return n;
    }
  }
  return undefined;
}

// Pull a per-side stats block. iSports analysis commonly nests team form here.
function pickSide(analysis: AnyObj, side: "home" | "away"): AnyObj {
  const candidates = [
    analysis?.[`${side}TeamFormStats`],
    analysis?.[`${side}TeamForm`],
    analysis?.[`${side}Stats`],
    analysis?.teamForm?.[side],
    analysis?.stats?.[side],
    analysis?.data?.[`${side}TeamFormStats`],
    analysis?.data?.[`${side}Stats`],
  ];
  return candidates.find((c) => c && typeof c === "object") ?? {};
}

export type CornerPrediction = {
  type: "over_6_5_corners";
  selection: string;
  projectedCorners: number;
  confidence: number;
  riskLevel: "low" | "medium" | "high";
  reasons: string[];
  stats: AnyObj;
};

export function predictCorners(analysis: AnyObj): CornerPrediction | null {
  const home = pickSide(analysis, "home");
  const away = pickSide(analysis, "away");

  const homeFor = findNum(home, ["cornersfor", "cornersper", "avgcorners", "corner"]);
  const awayFor = findNum(away, ["cornersfor", "cornersper", "avgcorners", "corner"]);
  const homeAg = findNum(home, ["cornersagainst", "concededcorners", "cornersconceded"]);
  const awayAg = findNum(away, ["cornersagainst", "concededcorners", "cornersconceded"]);

  // Need at least the two attacking-corner averages.
  if (homeFor === undefined || awayFor === undefined) return null;

  const hAg = homeAg ?? homeFor * 0.9;
  const aAg = awayAg ?? awayFor * 0.9;

  let projected =
    homeFor * 0.35 + awayFor * 0.25 + hAg * 0.2 + aAg * 0.2;

  const reasons: string[] = [
    `Home avg corners for ${homeFor.toFixed(2)}, away ${awayFor.toFixed(2)}.`,
    `Conceded corners — home ${hAg.toFixed(2)} / away ${aAg.toFixed(2)}.`,
  ];

  // Modifiers — only apply when source numbers exist.
  const homeShots = findNum(home, ["shotspergame", "shots", "shotsavg"]);
  const awayShots = findNum(away, ["shotspergame", "shots", "shotsavg"]);
  if (homeShots !== undefined && awayShots !== undefined) {
    const tempo = (homeShots + awayShots) / 2;
    if (tempo >= 13) { projected += 0.6; reasons.push(`High shot volume (avg ${tempo.toFixed(1)}/g).`); }
    else if (tempo <= 9) { projected -= 0.5; reasons.push(`Low shot volume (avg ${tempo.toFixed(1)}/g).`); }
  }
  const homeAtt = findNum(home, ["attack", "xg"]);
  const awayAtt = findNum(away, ["attack", "xg"]);
  if (homeAtt !== undefined && awayAtt !== undefined) {
    if (homeAtt + awayAtt >= 3.0) { projected += 0.4; reasons.push("Strong combined attacking output."); }
  }

  // Confidence model
  const margin = projected - 6.5;
  let confidence = 50 + margin * 9; // every corner above 6.5 ≈ +9%
  // Penalise if data sparse
  const dataPoints = [homeFor, awayFor, homeAg, awayAg, homeShots, awayShots].filter((v) => v !== undefined).length;
  if (dataPoints < 4) confidence -= 8;
  confidence = Math.max(0, Math.min(96, confidence));

  if (confidence < 75 || projected < 8) return null;

  const riskLevel: CornerPrediction["riskLevel"] = confidence >= 85 ? "low" : confidence >= 80 ? "medium" : "high";
  return {
    type: "over_6_5_corners",
    selection: "Over 6.5 Corners",
    projectedCorners: Math.round(projected * 100) / 100,
    confidence: Math.round(confidence * 10) / 10,
    riskLevel,
    reasons,
    stats: { homeFor, awayFor, homeAg: hAg, awayAg: aAg, homeShots, awayShots },
  };
}

export type MatchPrediction = {
  type: "match_winner" | "double_chance" | "asian_handicap" | "over_1_5_goals";
  selection: string;
  confidence: number;
  riskLevel: "low" | "medium" | "high";
  reasons: string[];
  stats: AnyObj;
};

export function predictMatchOutcomes(analysis: AnyObj): MatchPrediction[] {
  const home = pickSide(analysis, "home");
  const away = pickSide(analysis, "away");

  const homeGF = findNum(home, ["goalsfor", "goalsscored", "scored", "gpg"]);
  const awayGF = findNum(away, ["goalsfor", "goalsscored", "scored", "gpg"]);
  const homeGA = findNum(home, ["goalsagainst", "conceded"]);
  const awayGA = findNum(away, ["goalsagainst", "conceded"]);
  const homeWin = findNum(home, ["winrate", "wins%", "winpercentage", "winratehome"]);
  const awayWin = findNum(away, ["winrate", "wins%", "winpercentage", "winrateaway"]);
  const homeForm = findNum(home, ["form", "rating", "points"]);
  const awayForm = findNum(away, ["form", "rating", "points"]);

  if (homeGF === undefined || awayGF === undefined) return [];

  const out: MatchPrediction[] = [];

  // --- Match winner / double chance
  // Build a strength index in [0,1] per side
  const strength = (gf?: number, ga?: number, win?: number, form?: number) => {
    let s = 0, n = 0;
    if (gf !== undefined) { s += Math.min(gf, 3) / 3; n++; }
    if (ga !== undefined) { s += (1 - Math.min(ga, 3) / 3); n++; }
    if (win !== undefined) { s += Math.min(win, 100) / 100; n++; }
    if (form !== undefined) { s += Math.min(form, 100) / 100; n++; }
    return n ? s / n : 0.5;
  };
  const homeS = strength(homeGF, homeGA, homeWin, homeForm) + 0.05; // home edge
  const awayS = strength(awayGF, awayGA, awayWin, awayForm);
  const total = homeS + awayS || 1;
  const homeProb = homeS / total;
  const awayProb = awayS / total;
  const drawProb = Math.max(0, 1 - homeProb - awayProb + 0.2); // soften
  const norm = homeProb + awayProb + drawProb;
  const pH = homeProb / norm, pA = awayProb / norm, pD = drawProb / norm;

  const winnerConfidence = Math.round(Math.max(pH, pA) * 100 * 10) / 10;
  if (winnerConfidence >= 75) {
    const homeWins = pH >= pA;
    out.push({
      type: "match_winner",
      selection: homeWins ? "Home Win" : "Away Win",
      confidence: winnerConfidence,
      riskLevel: winnerConfidence >= 85 ? "low" : "medium",
      reasons: [
        `Strength index — home ${(homeS * 100).toFixed(0)} vs away ${(awayS * 100).toFixed(0)}.`,
        `Goals/g — H ${homeGF.toFixed(2)} A ${awayGF.toFixed(2)}.`,
      ],
      stats: { pH, pA, pD, homeS, awayS },
    });
  }

  // Double chance always safer; emit if either side meaningfully ahead
  const dcConf = Math.round((pH >= pA ? pH + pD : pA + pD) * 100 * 10) / 10;
  if (dcConf >= 78) {
    out.push({
      type: "double_chance",
      selection: pH >= pA ? "Home or Draw (1X)" : "Draw or Away (X2)",
      confidence: Math.min(94, dcConf),
      riskLevel: "low",
      reasons: [`Combined probability ${dcConf.toFixed(1)}% based on form and scoring rates.`],
      stats: { pH, pA, pD },
    });
  }

  // Asian Handicap — favour the stronger side at -0.25 / +0.25
  const edge = Math.abs(homeS - awayS);
  if (edge >= 0.18) {
    const ahConf = Math.round(Math.min(90, 70 + edge * 100) * 10) / 10;
    if (ahConf >= 75) {
      out.push({
        type: "asian_handicap",
        selection: pH >= pA ? "Home -0.25 AH" : "Away -0.25 AH",
        confidence: ahConf,
        riskLevel: ahConf >= 85 ? "low" : "medium",
        reasons: [`Strength gap ${(edge * 100).toFixed(0)} pts justifies a quarter-line.`],
        stats: { edge, homeS, awayS },
      });
    }
  }

  // Over 1.5 goals — based on combined goals expectation
  const expGoals = Math.min(5, homeGF * 0.85 + awayGF * 0.85 + (homeGA ?? 1) * 0.15 + (awayGA ?? 1) * 0.15);
  // Poisson P(>=2) approximation
  const lambda = expGoals;
  const p0 = Math.exp(-lambda);
  const p1 = lambda * p0;
  const pOver15 = Math.max(0, 1 - p0 - p1);
  const ovConf = Math.round(pOver15 * 100 * 10) / 10;
  if (ovConf >= 78) {
    out.push({
      type: "over_1_5_goals",
      selection: "Over 1.5 Goals",
      confidence: Math.min(95, ovConf),
      riskLevel: ovConf >= 85 ? "low" : "medium",
      reasons: [`Expected goals ${expGoals.toFixed(2)} (Poisson P(2+) = ${(pOver15 * 100).toFixed(0)}%).`],
      stats: { expGoals, pOver15 },
    });
  }

  return out;
}
