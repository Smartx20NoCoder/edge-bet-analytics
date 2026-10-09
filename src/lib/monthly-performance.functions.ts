import {monthlyPickSummary} from './monthly-pick-summary';
import { requireAdmin } from "./admin-auth.server";
import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const getMonthlyPickPerformance = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => {
    const value = (d ?? {}) as { months?: unknown; accessToken?: string };
    const months = value.months == null ? 6 : Number(value.months);
    if (!Number.isInteger(months) || months < 1 || months > 12) {
      throw new Error("months must be an integer from 1 to 12");
    }
    return { months, accessToken: value.accessToken ?? "" };
  })
  .handler(async ({ data }) => {
    await requireAdmin(data.accessToken);
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
      ? await supabaseAdmin.from("predictions").select("id, is_correct, market_odds, ft_status").in("id", Array.from(idsNeeded))
      : { data: [] as Array<{id: string; is_correct: boolean | null; market_odds: number | null; ft_status: string | null}>, error: null };
    if (predsError) throw new Error(predsError.message);

    return {months: monthlyPickSummary(locks, preds ?? [])};
  });
