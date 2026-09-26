/**
 * EV Quality research utilities.
 *
 * Important: this module deliberately does NOT change mathematical EV.
 * It captures market-evidence measurements so they can be validated against
 * settled production outcomes before any selection formula is introduced.
 */

export type MarketDistribution = {
  min: number;
  max: number;
  median: number;
  range: number;
  stdDev: number;
  count: number;
};

export function summarizeMarketPrices(prices: number[]): MarketDistribution | null {
  const clean = prices.filter((v) => Number.isFinite(v) && v > 1);
  if (!clean.length) return null;

  const sorted = [...clean].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
  const mean = clean.reduce((sum, v) => sum + v, 0) / clean.length;
  const variance = clean.reduce((sum, v) => sum + (v - mean) ** 2, 0) / clean.length;

  return {
    min: Number(Math.min(...clean).toFixed(3)),
    max: Number(Math.max(...clean).toFixed(3)),
    median: Number(median.toFixed(3)),
    range: Number((Math.max(...clean) - Math.min(...clean)).toFixed(3)),
    stdDev: Number(Math.sqrt(variance).toFixed(3)),
    count: clean.length,
  };
}

export type EvEvidenceObservation = {
  modelProbability: number;
  marketOdds: number;
  expectedValue: number;
  confidence: number;
  bookmakers?: number;
  result?: boolean | null;
};

/**
 * Mathematical EV is intentionally the only value calculation here.
 * Evidence is returned separately for later empirical validation.
 */
export function buildEvEvidence(observation: EvEvidenceObservation) {
  return {
    ev: observation.expectedValue,
    modelProbability: observation.modelProbability,
    confidence: observation.confidence,
    bookmakers: observation.bookmakers ?? null,
  };
}
