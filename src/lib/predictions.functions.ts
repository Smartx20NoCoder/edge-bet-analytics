import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchMatchAnalysis, fetchResultsByDate, fetchScheduleByDate, hasMainOdds, setForcedKey } from "./isports.server";
import { gradePrediction, predictCorners, predictMatchOutcomes, meetsConfidenceThreshold } from "./predictions.server";

const BLOCKED_KEYWORDS = [
  "friendly", "futsal", "u17", "u18", "u19", "u20", "u21", "u23", "youth", "reserve", "women",
  "u-17", "u-18", "u-19", "u-20", "u-21", "u-23",
  "under-17", "under-18", "under-19", "under-20", "under-21", "under-23",
  "under 17", "under 18", "under 19", "under 20", "under 21", "under 23",
  "cup", "copa", "coupe", "pokal", "trophy", "shield", "supercup", "super cup",
  "amateur", "regional", "lower", "qualifier", "qualifying", "playoff", "play-off",
  "exhibition", "test match", "invitational", "pre-season", "preseason", "trial",
  "caf", "afcon", "africa cup", "african cup", "uefa nations", "nations league",
  "copa america", "gold cup", "concacaf", "conmebol", "afc championship",
  "asian cup", "oceania", "world cup", "international",
];

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

// Regional/state qualifiers that indicate a lower, non-elite competition even when the
// name contains a trusted-sounding phrase like "premier league" (e.g. Australian state
// NPL comps branded "Queensland Premier League", "Victoria Premier League", etc.).
const MINOR_QUALIFIERS = [
  "queensland", "victoria", "victorian", "new south wales", "western australia",
  "south australia", "tasmania", "northern territory", "capital territory",
  "state league", "npl", "county", "district", "metro",
  "nsw", "vic", "qld", " sa ", " wa ", "tas", "act", " nt ",
];
// A trailing tier number ("... League 2", "... Premier League 3") is a strong signal of a
// lower division that a loose substring match on "premier league" alone would miss.
function hasTierNumber(name: string): boolean {
  return /\b[2-9]\b\s*$/.test(name.trim());
}
// Women's fixtures aren't reliably flagged by league name alone (e.g. "WK League" doesn't
// say "women") — the marker is usually on the team names instead ("(W)" suffix, etc.).
export function isWomensFixture(homeName?: string, awayName?: string): boolean {
  const check = (n?: string) => {
    if (!n) return false;
    const s = n.toLowerCase();
    return /\(w\)\s*$/i.test(n.trim()) || s.includes("women") || s.includes("ladies") || s.includes("féminine") || s.includes("frauen") || s.includes("damen");
  };
  return check(homeName) || check(awayName);
}
function isBlocked(name?: string) {
  if (!name) return true;
  const n = name.toLowerCase();
  return BLOCKED_KEYWORDS.some((k) => n.includes(k)) || hasTierNumber(name);
}
function isTrusted(name?: string) {
  if (!name) return false;
  const n = name.toLowerCase();
  if (MINOR_QUALIFIERS.some((q) => n.includes(q))) return false;
  if (hasTierNumber(name)) return false;
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
  // Scanner focuses on match_winner and over_2_5_goals only — the only two bet types with
  // a real, measurable edge available in this API's data (double chance, asian handicap
  // and corners were removed — no genuine market price exists for those to compute EV against).
  betType: z.enum(["all","match_winner","over_2_5_goals"]).optional(),
});

const MATCH_TYPES = new Set(["match_winner","over_2_5_goals"]);

export const runAnalysis = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => RunInput.parse(d ?? {}))
  .handler(async ({ data }) => {
    const date = data.date ?? new Date().toISOString().slice(0, 10);
    const timeframeHours = data.timeframeHours ?? 12;
    const maxMatches = data.maxMatches ?? 15;
    const maxPicks = data.maxPicks ?? 3;
    const minOdds = data.minOdds ?? 1.0;
    const trustedOnly = data.trustedOnly ?? true;
    const betType = data.betType ?? "all";
    const runCorners = false; // corners engine removed from the scanner — no EV available for it.
    const runMatch = betType === "all" || MATCH_TYPES.has(betType);

    const all = await fetchScheduleByDate(date);
    const now = Date.now();
    const windowEnd = now + timeframeHours * 3600 * 1000;

    const candidates = all
      .filter((m) => m.matchTime * 1000 > now) // strictly future
      .filter((m) => m.matchTime * 1000 <= windowEnd)
      .filter((m) => !isBlocked(m.leagueName))
      .filter((m) => !isWomensFixture(m.homeName, m.awayName))
      .filter((m) => (trustedOnly ? isTrusted(m.leagueName) : true))
      .sort((a, b) => a.matchTime - b.matchTime)
      .slice(0, maxMatches);

    // Dedup: skip matches that already have any prediction recorded.
    let skippedExisting = 0;
    let candidatesAfterDedup = candidates;
    if (candidates.length) {
      const ids = candidates.map((c) => String(c.matchId));
      const { data: existing } = await supabaseAdmin
        .from("predictions")
        .select("match_id")
        .in("match_id", ids);
      const existingSet = new Set((existing ?? []).map((r: any) => String(r.match_id)));
      candidatesAfterDedup = candidates.filter((c) => !existingSet.has(String(c.matchId)));
      skippedExisting = candidates.length - candidatesAfterDedup.length;
      if (skippedExisting) console.log(`[runAnalysis] skipped ${skippedExisting} already-predicted matches`);
    }
    const finalCandidates = candidatesAfterDedup;

    const scanStartedAt = new Date().toISOString();

    const predictions: any[] = [];
    const seen = new Set<string>();

    for (const m of finalCandidates) {
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

        const corners = runCorners ? predictCorners(analysis, m.homeId, m.awayId) : [];
        const matchPreds = runMatch ? predictMatchOutcomes(analysis, m.homeId, m.awayId) : [];

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
            // Only match_winner ever has a real expectedValue — see predictions.server.ts.
            recommendation: p.expectedValue !== undefined
              ? `Lean ${p.selection} — ${p.expectedValue >= 0 ? "+" : ""}${(p.expectedValue * 100).toFixed(1)}% edge at ${p.marketOdds!.toFixed(2)} odds.`
              : `Lean ${p.selection} (${p.confidence}% model confidence, no market price).`,
            market_odds: p.marketOdds ?? null,
            model_probability: p.modelProbability ?? null,
            expected_value: p.expectedValue ?? null,
          });
        }

        const filteredAll = betType === "all" ? all : all.filter((x) => x.prediction_type === betType);
        // Prefer real, priced edge over raw confidence: picks with a computed expected_value
        // sort by EV first (highest edge vs the market), everything else (no market price
        // available for that bet type) falls back to confidence ordering below them.
        filteredAll.sort((a, b) => {
          const evA = a.expected_value, evB = b.expected_value;
          if (evA != null && evB != null) return Number(evB) - Number(evA);
          if (evA != null) return -1;
          if (evB != null) return 1;
          return Number(b.confidence) - Number(a.confidence);
        });
        const best = filteredAll[0];
        if (best) {
          predictions.push({
            ...best,
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

    // Threshold + implied-odds filter, then top maxPicks overall.
    // Same EV-first, confidence-fallback ordering as above, applied across all matches.
    const passedThreshold = predictions
      .filter((p) => meetsConfidenceThreshold(p.prediction_type, Number(p.confidence)))
      .filter((p) => 100 / Number(p.confidence) >= minOdds)
      .sort((a, b) => {
        const evA = a.expected_value, evB = b.expected_value;
        if (evA != null && evB != null) return Number(evB) - Number(evA);
        if (evA != null) return -1;
        if (evB != null) return 1;
        return Number(b.confidence) - Number(a.confidence);
      })
      .slice(0, maxPicks);

    // Bookmaker availability check — annotate, don't drop.
    let noOddsCount = 0;
    const finalPreds: any[] = [];
    for (const p of passedThreshold) {
      const ok = await hasMainOdds(String(p.match_id));
      if (!ok) noOddsCount++;
      // If the live odds feed couldn't confirm a real bookmaker price, the EV number
      // (computed from odds embedded in the /analysis payload, a separate and less
      // reliable source) isn't trustworthy either — null it out rather than show a
      // confident edge figure next to a "no odds" warning.
      if (!ok && p.expected_value != null) {
        finalPreds.push({
          ...p,
          market_odds: null,
          expected_value: null,
          recommendation: `Lean ${p.selection} (${p.confidence}% model confidence, price unconfirmed by live odds feed).`,
          stats: { ...(p.stats ?? {}), oddsAvailable: ok },
        });
      } else {
        finalPreds.push({
          ...p,
          stats: { ...(p.stats ?? {}), oddsAvailable: ok },
        });
      }
    }
    if (noOddsCount) console.log(`[runAnalysis] flagged ${noOddsCount} picks with no 1X2 bookmaker odds`);
    

    // Skip saving empty scans entirely.
    if (!finalPreds.length) {
      return {
        analysisId: null,
        matchesAnalyzed: finalCandidates.length,
        skippedExisting,
        noOddsCount,
        predictionsGenerated: 0,
        date,
      };
    }

    const distinctLeagues = new Set(
      finalCandidates.map((c) => c.leagueName).filter(Boolean) as string[],
    ).size;
    const avg = finalPreds.reduce((s, p) => s + Number(p.confidence), 0) / finalPreds.length;

    const { data: analysisRow, error: aErr } = await supabaseAdmin
      .from("analyses")
      .insert({
        league_id: null,
        league_name: null,
        matches_analyzed: finalCandidates.length,
        predictions_generated: finalPreds.length,
        avg_confidence: Math.round(avg * 100) / 100,
        status: "completed",
        notes: JSON.stringify({ date, timeframeHours, maxMatches, minOdds, trustedOnly, betType, scanStartedAt, distinctLeagues, skippedExisting, noOddsCount }),
      })
      .select()
      .single();
    if (aErr || !analysisRow) throw new Error(aErr?.message ?? "analysis insert failed");

    await supabaseAdmin
      .from("predictions")
      .insert(finalPreds.map((p) => ({ ...p, analysis_id: analysisRow.id })));

    return {
      analysisId: analysisRow.id,
      matchesAnalyzed: finalCandidates.length,
      skippedExisting,
      noOddsCount,
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
    let analyses: any[] = (rows ?? []).map((a: any) => {
      let leagueScope: "major" | "all" | null = null;
      try {
        const parsed = a.notes ? JSON.parse(a.notes) : null;
        if (parsed && typeof parsed.trustedOnly === "boolean") {
          leagueScope = parsed.trustedOnly ? "major" : "all";
        }
      } catch {}
      return { ...a, league_scope: leagueScope };
    });
    const ids = analyses.map((a) => a.id);
    if (ids.length) {
      let pq = supabaseAdmin
        .from("predictions")
        .select("analysis_id, confidence, is_correct, engine")
        .in("analysis_id", ids);
      if (data.engine) pq = pq.eq("engine", data.engine);
      const { data: preds } = await pq;
      const counts: Record<string, { n: number; sum: number; won: number; lost: number; pending: number }> = {};
      for (const p of preds ?? []) {
        const k = (p as any).analysis_id;
        counts[k] ??= { n: 0, sum: 0, won: 0, lost: 0, pending: 0 };
        counts[k].n++;
        counts[k].sum += Number((p as any).confidence);
        const ic = (p as any).is_correct;
        if (ic === true) counts[k].won++;
        else if (ic === false) counts[k].lost++;
        else counts[k].pending++;
      }
      if (data.engine) {
        analyses = analyses
          .filter((a) => counts[a.id])
          .map((a) => ({
            ...a,
            predictions_generated: counts[a.id].n,
            avg_confidence: Math.round((counts[a.id].sum / counts[a.id].n) * 10) / 10,
            score_total: counts[a.id].n,
            score_won: counts[a.id].won,
            score_pending: counts[a.id].pending,
          }));
      } else {
        analyses = analyses.map((a) => {
          const c = counts[a.id];
          return {
            ...a,
            score_total: c?.n ?? 0,
            score_won: c?.won ?? 0,
            score_pending: c?.pending ?? 0,
          };
        });
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
  const { getApiKeySlotStatus } = await import("./isports.server");
  const slots = await getApiKeySlotStatus();
  const hasKey = slots.slot1 || slots.slot2;
  return { hasKey, live: hasKey, error: hasKey ? null : "no key", slots };
});

// Save (or clear, by passing an empty string) the iSportsAPI key for slot 1 or 2.
// Server-only — the key value is never returned to the browser by any function in
// this file, only booleans indicating whether a slot is configured.
export const setApiKey = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ slot: z.union([z.literal(1), z.literal(2)]), key: z.string().max(200) }).parse(d))
  .handler(async ({ data }) => {
    const { setApiKeyForSlot } = await import("./isports.server");
    await setApiKeyForSlot(data.slot, data.key);
    return { ok: true };
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
    let failedDates = 0;
    for (const [date, group] of Object.entries(byDate)) {
      let results: Awaited<ReturnType<typeof fetchResultsByDate>>;
      try {
        results = await fetchResultsByDate(date);
      } catch (e: any) {
        // A single date failing (e.g. trial-key date-range limits) shouldn't abort the
        // whole batch — skip this date's predictions and keep going with the rest.
        failedDates++;
        console.warn(`[updateResults] date=${date} fetch failed, skipping: ${e?.message ?? e}`);
        continue;
      }
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
    console.log(`[updateResults] analysisId=${data.analysisId} totalPreds=${preds.length} totalFinishedResults=${totalResults} updated=${updated} skipped=${skipped} noResultFound=${noResultFound} failedDates=${failedDates}`);
    return { updated, skipped, noResultFound, failedDates };
  });

export const updateAllPendingResults = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ apiKey: z.union([z.literal(1), z.literal(2)]).optional() }).parse(d ?? {}))
  .handler(async ({ data }) => {
  const forced = data.apiKey ?? null;
  if (forced) setForcedKey(forced);
  try {
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
  let failedDates = 0;
  const dates = Object.keys(byDate);
  for (const [date, group] of Object.entries(byDate)) {
    let results: Awaited<ReturnType<typeof fetchResultsByDate>>;
    try {
      results = await fetchResultsByDate(date);
    } catch (e: any) {
      // A single date failing (e.g. trial-key date-range limits, like "Date out of range")
      // shouldn't abort the whole batch — skip this date and keep going with the rest.
      failedDates++;
      console.warn(`[updateAllPendingResults] date=${date} fetch failed, skipping: ${e?.message ?? e}`);
      stillPending += group.length;
      continue;
    }
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
  console.log(`[updateAllPendingResults] scanned=${preds.length} updated=${updated} stillPending=${stillPending} dates=${dates.length} failedDates=${failedDates} forcedKey=${forced ?? "auto"}`);
  return { updated, stillPending, dates: dates.length, totalScanned: preds.length, failedDates };
  } finally {
    if (forced) setForcedKey(null);
  }
});
