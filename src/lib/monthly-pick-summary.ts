import {settleSlip, type SavedLeg} from './slip-settlement.ts';
type Pick = SavedLeg & {id: string};
type Lock = {day: string; single_prediction_id?: string | null; combo_prediction_id_1?: string | null; combo_prediction_id_2?: string | null};
export function monthlyPickSummary(locks: Lock[], predictions: Pick[]) {
  const byId = new Map(predictions.map(p => [String(p.id), p]));
  const byMonth: Record<string, {singleWin: number; singleLoss: number; singlePending: number; singleVoid: number; singleProfitLoss: number; comboWin: number; comboLoss: number; comboPending: number; comboVoid: number; comboProfitLoss: number}> = {};
  for (const lock of locks) {
    const month = byMonth[lock.day.slice(0, 7)] ??= {singleWin: 0, singleLoss: 0, singlePending: 0, singleVoid: 0, singleProfitLoss: 0, comboWin: 0, comboLoss: 0, comboPending: 0, comboVoid: 0, comboProfitLoss: 0};
    const single = lock.single_prediction_id ? byId.get(lock.single_prediction_id) : undefined;
    const leg1 = lock.combo_prediction_id_1 ? byId.get(lock.combo_prediction_id_1) : undefined;
    const leg2 = lock.combo_prediction_id_2 ? byId.get(lock.combo_prediction_id_2) : undefined;
    for (const [kind, legs] of [['single', single ? [single] : []], ['combo', leg1 && leg2 ? [leg1, leg2] : []]] as const) {
      if (!legs.length) continue;
      const result = settleSlip([...legs]);
      if (result.status === 'won') month[`${kind}Win`]++;
      else if (result.status === 'lost') month[`${kind}Loss`]++;
      else if (result.status === 'void') month[`${kind}Void`]++;
      else month[`${kind}Pending`]++;
      month[`${kind}ProfitLoss`] += result.profit ?? 0;
    }
  }
  return Object.entries(byMonth).sort((a, b) => b[0].localeCompare(a[0])).map(([month, s]) => ({
    month, ...s,
    singleProfitLoss: Math.round(s.singleProfitLoss * 100) / 100,
    comboProfitLoss: Math.round(s.comboProfitLoss * 100) / 100,
    singleWinRate: s.singleWin + s.singleLoss ? Math.round(100 * s.singleWin / (s.singleWin + s.singleLoss)) : null,
    comboWinRate: s.comboWin + s.comboLoss ? Math.round(100 * s.comboWin / (s.comboWin + s.comboLoss)) : null,
  }));
}
