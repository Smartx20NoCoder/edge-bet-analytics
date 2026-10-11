import type { LiveOdds } from './isports.server';

type Quote = { market: string; bookmaker: string; odds: number };
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Count distinct bookmakers, not repeated rows from the same bookmaker.
export function goalooLiveOdds(quotes: Quote[]): LiveOdds {
  const prices = (market: string) => [...new Map(quotes
    .filter(q => q.market === market && Number.isFinite(q.odds) && q.odds > 1)
    .map(q => [q.bookmaker.trim().toLowerCase(), q.odds])).values()];
  const h = prices('home'), d = prices('draw'), a = prices('away');
  const over = prices('total-over-2.5'), under = prices('total-under-2.5');
  const result: LiveOdds = { coverage: {
    oneXTwo: Math.min(h.length, d.length, a.length),
    goals25: Math.min(over.length, under.length),
  } };
  if (result.coverage!.oneXTwo >= 2) result.matchWinner = { oH: median(h), oD: median(d), oA: median(a), bookmakers: result.coverage!.oneXTwo };
  if (result.coverage!.goals25 >= 2) result.goals25 = { oOver: median(over), oUnder: median(under), bookmakers: result.coverage!.goals25 };
  for (const [market, key] of [['ah:home:0.5', 'ahHomePlus'], ['ah:away:0.5', 'ahAwayPlus']] as const) {
    const values = prices(market);
    if (values.length >= 2) result[key] = { odds: median(values), bookmakers: values.length };
  }
  return result;
}

export function goalooOddsAvailability(odds: LiveOdds, betType = 'all') {
  const accepted = betType === 'match_winner' ? !!odds.matchWinner
    : betType === 'over_2_5_goals' ? !!odds.goals25 : !!(odds.matchWinner || odds.goals25);
  const coverage = betType === 'match_winner' ? odds.coverage?.oneXTwo
    : betType === 'over_2_5_goals' ? odds.coverage?.goals25
      : Math.max(odds.coverage?.oneXTwo ?? 0, odds.coverage?.goals25 ?? 0);
  return accepted ? 'available' : (coverage ?? 0) > 0 ? 'insufficient_bookmakers' : 'missing_market';
}

export function inQuotedOddsRange(pick: { market_odds?: number | null }, minimum: number, maximum: number) {
  const odds = pick.market_odds;
  return typeof odds === 'number' && Number.isFinite(odds) && odds > 1 && odds >= minimum && odds <= maximum;
}

export function valuePickCounts(picks: { expected_value?: number | null; match_id?: string }[]) {
  const positive = picks.filter(p => typeof p.expected_value === 'number' && Number.isFinite(p.expected_value) && p.expected_value > 0);
  const eligible = picks.filter(p => typeof p.expected_value === 'number' && Number.isFinite(p.expected_value) && p.expected_value >= 0 && p.expected_value <= .40);
  return { positiveEvPicks: positive.length, dailyEligibleMatches: new Set(eligible.map(p => p.match_id)).size };
}
