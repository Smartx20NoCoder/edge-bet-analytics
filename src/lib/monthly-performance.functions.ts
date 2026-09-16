import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const getMonthlyPickPerformance = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => {
    const value = (d ?? {}) as { months?: unknown };
    const months = value.months == null ? 6 : Number(value.months);
    if (!Number.isInteger(months) || months < 1 || months > 12) {
      throw new Error("months must be an integer from 1 to 12");
    }
    return { months };
  })
  .handler(async ({ data }) => {
    const since = new Date();
    since.setMonth(since.getMonth() - data.months);
    const sinceStr = since.toISOString().slice(0, 10);

    const { data: locks, error: locksError } = await supabaseAdmin
      .from("daily_best_picks")
      .select("day, single_prediction_id, combo_prediction_id_1, combo_prediction_id_2")
      .gte("day", sinceStr);
    if (locksError) throw new Error(locksError.message);
    if (!locks?.length) return { months: [] };

    const idsNeeded = new Set<string>();
    for (const lock of locks) {
      if (lock.single_prediction_id) idsNeeded.add(String(lock.single_prediction_id));
      if (lock.combo_prediction_id_1) idsNeeded.add(String(lock.combo_prediction_id_1));
      if (lock.combo_prediction_id_2) idsNeeded.add(String(lock.combo_prediction_id_2));
    }

    const { data: preds, error: predsError } = idsNeeded.size
      ? await supabaseAdmin.from("predictions").select("id, is_correct").in("id", Array.from(idsNeeded))
      : { data: [] as Array<{ id: string; is_correct: boolean | null }>, error: null };
    if (predsError) throw new Error(predsError.message);

    const byId = new Map((preds ?? []).map((p) => [String(p.id), p]));
    const byMonth: Record<string, { singleWin: number; singleLoss: number; singlePending: number; comboWin: number; comboLoss: number; comboPending: number }> = {};

    for (const lock of locks) {
      const monthKey = String(lock.day).slice(0, 7);
      const month = (byMonth[monthKey] ??= { singleWin: 0, singleLoss: 0, singlePending: 0, comboWin: 0, comboLoss: 0, comboPending: 0 });

      const single = lock.single_prediction_id ? byId.get(String(lock.single_prediction_id)) : undefined;
      if (single) {
        if (single.is_correct === true) month.singleWin++;
        else if (single.is_correct === false) month.singleLoss++;
        else month.singlePending++;
      }

      const leg1 = lock.combo_prediction_id_1 ? byId.get(String(lock.combo_prediction_id_1)) : undefined;
      const leg2 = lock.combo_prediction_id_2 ? byId.get(String(lock.combo_prediction_id_2)) : undefined;
      if (leg1 && leg2) {
        const graded1 = leg1.is_correct === true || leg1.is_correct === false;
        const graded2 = leg2.is_correct === true || leg2.is_correct === false;
        if (graded1 && graded2) {
          if (leg1.is_correct === true && leg2.is_correct === true) month.comboWin++;
          else month.comboLoss++;
        } else {
          month.comboPending++;
        }
      }
    }

    return {
      months: Object.entries(byMonth)
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([month, s]) => ({
          month,
          singleWin: s.singleWin,
          singleLoss: s.singleLoss,
          singlePending: s.singlePending,
          singleWinRate: s.singleWin + s.singleLoss > 0 ? Math.round((s.singleWin / (s.singleWin + s.singleLoss)) * 100) : null,
          comboWin: s.comboWin,
          comboLoss: s.comboLoss,
          comboPending: s.comboPending,
          comboWinRate: s.comboWin + s.comboLoss > 0 ? Math.round((s.comboWin / (s.comboWin + s.comboLoss)) * 100) : null,
        })),
    };
  });
