export type SavedLeg = {
  ft_status?: string | number | null;
  is_correct?: boolean | null;
  market_odds?: string | number | null;
};

export function isVoidStatus(status: SavedLeg['ft_status']): boolean {
  // Goaloo's documented soccer states: -12 abandoned, -14 postponed.
  // -11 awaiting a time and -13 temporarily interrupted remain pending.
  return new Set(['AWARDED', 'VOID', 'VOIDED', 'POSTPONED', 'POSTP.', 'PSTP',
    'ABANDONED', 'ABD', 'CANCELLED', 'CANCELED', 'CANCEL', 'WALKOVER',
    'FORFEIT', 'FORFEITED', '-12', '-14']).has(String(status ?? '').trim().toUpperCase());
}

export function settleSlip(legs: SavedLeg[]) {
  const voidLegs = legs.filter(p => isVoidStatus(p.ft_status)).length;
  const remaining = legs.filter(p => !isVoidStatus(p.ft_status));
  const prices = remaining.map(p => Number(p.market_odds));
  const validPrices = prices.every(n => Number.isFinite(n) && n > 1);
  const combinedOdds = validPrices ? prices.reduce((n, price) => n * price, 1) : null;
  const status = !legs.length ? 'pending' : !remaining.length ? 'void'
    : remaining.some(p => p.is_correct === false) ? 'lost'
    : remaining.every(p => p.is_correct === true) ? 'won' : 'pending';
  const payout = status === 'void' ? 1 : status === 'lost' ? 0 : status === 'won' ? combinedOdds : null;
  return {
    status, voidLegs, combinedOdds,
    isCorrect: status === 'won' ? true : status === 'lost' ? false : null,
    payout, profit: payout === null ? null : payout - 1,
  };
}
