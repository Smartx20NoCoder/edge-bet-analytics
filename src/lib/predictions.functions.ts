import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchMatchAnalysis, fetchResultsByDate, fetchScheduleByDate } from "./isports.server";
import { gradePrediction, predictCorners, predictMatchOutcomes, meetsConfidenceThreshold } from "./predictions.server";

const BLOCKED_KEYWORDS = ["friendly", "u17", "u18", "u19", "u20", "u21", "u23", "youth", "reserve", "women"];

// Statistically reliable major leagues (name-substring match, lowercase).
const TRUSTED_LEAGUE_PATTERNS = [
  "premier league", "championship", "league one", "league two",
  "la liga", "segunda",
  "serie a", "serie b",
  "bundesliga", "2. bundesliga",
  "ligue 1", "ligue 2",
  "eredivisie", "primeira liga", "süper lig", "super lig",
  "champions league", "europa league", "conference league",
  "mls", "liga mx", "brasileir", "j league", "k league",
  "scottish premiership", "belgian", "swiss super",
];

function isBlocked(name?: string) {
  if (!name) return true;
  const n = name.toLowerCase();
  return BLOCKED_KEYWORDS.some((k) => n.includes(k));
}
function isTrusted(name?: string) {
  if (!name) return false;
  const n = name.toLowerCase();
  return TRUSTED_LEAGUE_PATTERNS.some((p) => n.includes(p));
}

const RunInput = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), // YYYY-MM-DD, defaults to today (UTC)
  timeframeHours: z.number().int().min(1).max(48).optional(), // upcoming window
  maxMatches: z.number().int().min(1).max(40).optional(),
  maxPicks: z.number().int().min(1).max(10).optional(),
  minOdds: z.number().min(1).max(10).optional(), // implied-odds floor (1/p)
  trustedOnly: z.boolean().optional(),
  refresh: z.boolean().optional(), // force re-fetch of analysis cache
});

export const runAnalysis = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => RunInput.parse(d ?? {}))
  .handler(async ({ data }) => {
    const date = data.date ?? new Date().toISOString().slice(0, 10);
    const timeframeHours = data.timeframeHours ?? 6;
    const maxMatches = data.maxMatches ?? 15;
    const maxPicks = data.maxPicks ?? 3;
    const minOdds = data.minOdds ?? 1.0;
    const trustedOnly = data.trustedOnly ?? true;

    const all = await fetchScheduleByDate(date);
    const now = Date.now();
    const windowEnd = now + timeframeHours * 3600 * 1000;

    const candidates = all
      .filter((m) => m.matchTime * 1000 > now) // strictly future
      .filter((m) => m.matchTime * 1000 <= windowEnd)
      .filter((m) => !isBlocked(m.leagueName))
      .filter((m) => (trustedOnly ? isTrusted(m.leagueName) : true))
      .sort((a, b) => a.matchTime - b.matchTime)
      .slice(0, maxMatches);

    const scanStartedAt = new Date().toISOString();

    const { data: analysisRow, error: aErr } = await supabaseAdmin
      .from("analyses")
      .insert({
        league_id: null,
        league_name: null,
        matches_analyzed: candidates.length,
        predictions_generated: 0,
        status: "running",
        notes: JSON.stringify({ date, timeframeHours, maxMatches, minOdds, trustedOnly, scanStartedAt }),
      })
      .select()
      .single();
    if (aErr || !analysisRow) throw new Error(aErr?.message ?? "analysis insert failed");

    const predictions: any[] = [];
    const seen = new Set<string>();

    for (const m of candidates) {
      if (seen.has(String(m.matchId))) continue;
      seen.add(String(m.matchId));
      try {
        const analysis = await fetchMatchAnalysis(m.matchId, data.refresh ?? false);

        await supabaseAdmin.from("fixtures_cache").upsert({
          match_id: m.matchId,
          league_id: m.leagueId,
          league_name: m.leagueName,
          home_team: m.homeName,
          away_team: m.awayName,
          kickoff: new Date(m.matchTime * 1000).toISOString(),
          raw: m.raw,
          fetched_at: new Date().toISOString(),
        });

        const corners = predictCorners(analysis, m.homeId, m.awayId);
        const matchPreds = predictMatchOutcomes(analysis, m.homeId, m.awayId);

        const all: any[] = [];
        for (const c of corners) {
          all.push({
            engine: "corners",
            prediction_type: c.type,
            selection: c.selection,
            projected_corners: c.projectedCorners,
            confidence: c.confidence,
            risk_level: c.riskLevel,
            reasons: c.reasons,
            stats: c.stats,
            recommendation: `Bet ${c.selection} — projected ${c.projectedCorners} corners.`,
          });
        }
        for (const p of matchPreds) {
          all.push({
            engine: "match",
            prediction_type: p.type,
            selection: p.selection,
            confidence: p.confidence,
            risk_level: p.riskLevel,
            reasons: p.reasons,
            stats: p.stats,
            recommendation: `Lean ${p.selection} (${p.confidence}% model confidence).`,
          });
        }

        // One best pick per match.
        all.sort((a, b) => Number(b.confidence) - Number(a.confidence));
        const best = all[0];
        if (best) {
          predictions.push({
            ...best,
            analysis_id: analysisRow.id,
            match_id: m.matchId,
            home_team: m.homeName,
            away_team: m.awayName,
            league_id: m.leagueId,
            league_name: m.leagueName,
            kickoff: new Date(m.matchTime * 1000).toISOString(),
          });
        }
      } catch (e) {
        console.error(`Match ${m.matchId} failed:`, e);
      }
    }

    // Apply threshold + implied-odds filter, then keep only the top maxPicks overall.
    const finalPreds = predictions
      .filter((p) => meetsConfidenceThreshold(p.prediction_type, Number(p.confidence)))
      .filter((p) => 100 / Number(p.confidence) >= minOdds)
      .sort((a, b) => Number(b.confidence) - Number(a.confidence))
      .slice(0, maxPicks);

    if (finalPreds.length) {
      await supabaseAdmin.from("predictions").insert(finalPreds);
    }

    const avg = finalPreds.length
      ? finalPreds.reduce((s, p) => s + Number(p.confidence), 0) / finalPreds.length
      : null;
    const distinctLeagues = new Set(
      candidates.map((c) => c.leagueName).filter(Boolean) as string[],
    ).size;
    await supabaseAdmin
      .from("analyses")
      .update({
        predictions_generated: finalPreds.length,
        avg_confidence: avg ? Math.round(avg * 100) / 100 : null,
        status: "completed",
        notes: JSON.stringify({ date, timeframeHours, maxMatches, minOdds, trustedOnly, scanStartedAt, distinctLeagues }),
      })
      .eq("id", analysisRow.id);

    return {
      analysisId: analysisRow.id,
      matchesAnalyzed: candidates.length,
      predictionsGenerated: finalPreds.length,
      date,
    };
  });

export const getAnalyses = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ engine: z.enum(["corners", "match"]).optional() }).parse(d ?? {}))
  .handler(async ({ data }) => {
    const { data: rows, error } = await supabaseAdmin
      .from("analyses")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    let analyses: any[] = rows ?? [];
    if (data.engine) {
      const ids = analyses.map((a) => a.id);
      if (ids.length) {
        const { data: preds } = await supabaseAdmin
          .from("predictions")
          .select("analysis_id, confidence")
          .eq("engine", data.engine)
          .in("analysis_id", ids);
        const counts: Record<string, { n: number; sum: number }> = {};
        for (const p of preds ?? []) {
          const k = (p as any).analysis_id;
          counts[k] ??= { n: 0, sum: 0 };
          counts[k].n++;
          counts[k].sum += Number((p as any).confidence);
        }
        analyses = analyses
          .filter((a) => counts[a.id])
          .map((a) => ({
            ...a,
            predictions_generated: counts[a.id].n,
            avg_confidence: Math.round((counts[a.id].sum / counts[a.id].n) * 10) / 10,
          }));
      } else {
        analyses = [];
      }
    }
    return { analyses };
  });

export const getPredictions = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({
      engine: z.enum(["corners", "match"]).optional(),
      analysisId: z.string().optional(),
      predictionType: z.string().optional(),
    }).parse(d ?? {})
  )
  .handler(async ({ data }) => {
    let q = supabaseAdmin.from("predictions").select("*").order("confidence", { ascending: false }).limit(200);
    if (data.engine) q = q.eq("engine", data.engine);
    if (data.analysisId) q = q.eq("analysis_id", data.analysisId);
    if (data.predictionType) q = q.eq("prediction_type", data.predictionType);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { predictions: rows ?? [] };
  });

export const getDashboardStats = createServerFn({ method: "GET" }).handler(async () => {
  const [{ data: analyses }, { data: predictions }] = await Promise.all([
    supabaseAdmin.from("analyses").select("*").order("created_at", { ascending: false }).limit(20),
    supabaseAdmin.from("predictions").select("league_name, confidence, engine, is_correct").limit(1000),
  ]);
  const matches = (analyses ?? []).reduce((s, a: any) => s + (a.matches_analyzed ?? 0), 0);
  const preds = predictions ?? [];
  const avg = preds.length ? preds.reduce((s: number, p: any) => s + Number(p.confidence), 0) / preds.length : 0;
  const graded = preds.filter((p: any) => p.is_correct !== null && p.is_correct !== undefined);
  const wins = graded.filter((p: any) => p.is_correct === true).length;
  const winRate = graded.length ? Math.round((wins / graded.length) * 1000) / 10 : null;
  const byLeague: Record<string, { count: number; sum: number }> = {};
  for (const p of preds as any[]) {
    const k = p.league_name ?? "Unknown";
    byLeague[k] ??= { count: 0, sum: 0 };
    byLeague[k].count++;
    byLeague[k].sum += Number(p.confidence);
  }
  const topLeagues = Object.entries(byLeague)
    .map(([name, v]) => ({ name, count: v.count, avgConfidence: Math.round((v.sum / v.count) * 10) / 10 }))
    .sort((a, b) => b.avgConfidence - a.avgConfidence)
    .slice(0, 5);
  return {
    matchesAnalyzed: matches,
    avgConfidence: Math.round(avg * 10) / 10,
    totalPredictions: preds.length,
    totalScans: (analyses ?? []).length,
    gradedPredictions: graded.length,
    winRate,
    topLeagues,
    recentAnalyses: analyses ?? [],
  };
});

export const checkApiStatus = createServerFn({ method: "GET" }).handler(async () => {
  const hasKey = Boolean(process.env.ISPORTS_API_KEY);
  return { hasKey, live: hasKey, error: hasKey ? null : "no key" };
});

export const getApiUsageToday = createServerFn({ method: "GET" }).handler(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const startOfDay = new Date(today + "T00:00:00.000Z").toISOString();

  // Look for a failover marker today.
  const { data: failoverRows } = await supabaseAdmin
    .from("api_usage")
    .select("called_at")
    .eq("endpoint", "__failover")
    .gte("called_at", startOfDay)
    .order("called_at", { ascending: false })
    .limit(1);
  const failoverAt = failoverRows && failoverRows.length ? failoverRows[0].called_at : null;

  // Active key: read api_key_status; if key 1 inactive/exhausted -> key 2.
  const { data: statusRows } = await supabaseAdmin
    .from("api_key_status")
    .select("key_index, exhausted_at, active");
  const k1 = statusRows?.find((r: any) => r.key_index === 1);
  const activeKey: 1 | 2 = k1 && (k1.active === false || k1.exhausted_at) ? 2 : 1;

  // Count calls today, filtered to after the failover timestamp if present.
  let q = supabaseAdmin
    .from("api_usage")
    .select("*", { count: "exact", head: true })
    .eq("date", today)
    .neq("endpoint", "__failover");
  if (failoverAt) q = q.gte("called_at", failoverAt);
  const { count, error } = await q;
  if (error) {
    console.warn(`[getApiUsageToday] ${error.message}`);
    return { count: 0, limit: 200, activeKey, failoverAt };
  }
  return { count: count ?? 0, limit: 200, activeKey, failoverAt };
});

export const updateResults = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ analysisId: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const { data: preds, error } = await supabaseAdmin
      .from("predictions")
      .select("*")
      .eq("analysis_id", data.analysisId);
    if (error) throw new Error(error.message);
    if (!preds || !preds.length) return { updated: 0, skipped: 0, noResultFound: 0 };

    // Group by date for efficient batched results fetch
    const byDate: Record<string, any[]> = {};
    for (const p of preds) {
      if (!p.kickoff) continue;
      const d = new Date(p.kickoff).toISOString().slice(0, 10);
      (byDate[d] ??= []).push(p);
    }

    let updated = 0;
    let skipped = 0;
    let noResultFound = 0;
    let totalResults = 0;
    for (const [date, group] of Object.entries(byDate)) {
      const results = await fetchResultsByDate(date);
      totalResults += results.length;
      const map = new Map(results.map((r) => [r.matchId, r]));
      console.log(`[updateResults] date=${date} predictions=${group.length} finishedResults=${results.length}`);
      for (const p of group) {
        const r = map.get(String(p.match_id));
        if (!r) { noResultFound++; continue; }
        if (r.homeScore == null && r.awayScore == null) { skipped++; continue; }
        const correct = gradePrediction(p.prediction_type, p.selection, r);
        const totalC = (r.homeCorners ?? 0) + (r.awayCorners ?? 0);
        await supabaseAdmin
          .from("predictions")
          .update({
            home_score: r.homeScore,
            away_score: r.awayScore,
            total_corners: r.homeCorners != null && r.awayCorners != null ? totalC : null,
            ft_status: r.status,
            is_correct: correct,
            results_updated_at: new Date().toISOString(),
          })
          .eq("id", p.id);
        updated++;
      }
    }
    console.log(`[updateResults] analysisId=${data.analysisId} totalPreds=${preds.length} totalFinishedResults=${totalResults} updated=${updated} skipped=${skipped} noResultFound=${noResultFound}`);
    return { updated, skipped, noResultFound };
  });

export const updateAllPendingResults = createServerFn({ method: "POST" }).handler(async () => {
  const { data: preds, error } = await supabaseAdmin
    .from("predictions")
    .select("*")
    .is("is_correct", null);
  if (error) throw new Error(error.message);
  if (!preds || !preds.length) return { updated: 0, stillPending: 0, dates: 0, totalScanned: 0 };

  const byDate: Record<string, any[]> = {};
  for (const p of preds) {
    if (!p.kickoff) continue;
    const d = new Date(p.kickoff).toISOString().slice(0, 10);
    (byDate[d] ??= []).push(p);
  }

  let updated = 0;
  let stillPending = 0;
  const dates = Object.keys(byDate);
  for (const [date, group] of Object.entries(byDate)) {
    const results = await fetchResultsByDate(date);
    const map = new Map(results.map((r) => [r.matchId, r]));
    for (const p of group) {
      const r = map.get(String(p.match_id));
      if (!r || (r.homeScore == null && r.awayScore == null)) { stillPending++; continue; }
      const correct = gradePrediction(p.prediction_type, p.selection, r);
      const totalC = (r.homeCorners ?? 0) + (r.awayCorners ?? 0);
      await supabaseAdmin
        .from("predictions")
        .update({
          home_score: r.homeScore,
          away_score: r.awayScore,
          total_corners: r.homeCorners != null && r.awayCorners != null ? totalC : null,
          ft_status: r.status,
          is_correct: correct,
          results_updated_at: new Date().toISOString(),
        })
        .eq("id", p.id);
      updated++;
    }
  }
  console.log(`[updateAllPendingResults] scanned=${preds.length} updated=${updated} stillPending=${stillPending} dates=${dates.length}`);
  return { updated, stillPending, dates: dates.length, totalScanned: preds.length };
});
