import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchMatchAnalysis, fetchResultsByDate, fetchScheduleByDate, fetchLiveOdds, setForcedKey } from "./isports.server";
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

const MINOR_QUALIFIERS = [
  "queensland", "victoria", "victorian", "new south wales", "western australia",
  "south australia", "tasmania", "northern territory", "capital territory",
  "state league", "npl", "county", "district", "metro",
  "nsw", "vic", "qld", " sa ", " wa ", "tas", "act", " nt ",
];
function hasTierNumber(name: string): boolean {
  return /\b[2-9]\b\s*$/.test(name.trim());
}
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
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  timeframeHours: z.number().int().min(1).max(48).optional(),
  maxMatches: z.number().int().min(1).max(40).optional(),
  maxPicks: z.number().int().min(1).max(10).optional(),
  minOdds: z.number().min(1).max(10).optional(),
  trustedOnly: z.boolean().optional(),
  refresh: z.boolean().optional(),
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
    const runCorners = false;
    const runMatch = betType === "all" || MATCH_TYPES.has(betType);

    const all = await fetchScheduleByDate(date);
    const now = Date.now();
    const windowEnd = now + timeframeHours * 3600 * 1000;

    const candidates = all
      .filter((m) => m.matchTime * 1000 > now)
      .filter((m) => m.matchTime * 1000 <= windowEnd)
      .filter((m) => !isBlocked(m.leagueName))
      .filter((m) => !isWomensFixture(m.homeName, m.awayName))
      .filter((m) => (trustedOnly ? isTrusted(m.leagueName) : true))
      .sort((a, b) => a.matchTime - b.matchTime)
      .slice(0, maxMatches);

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
        const matchPreds = runMatch
          ? predictMatchOutcomes(analysis, m.homeId, m.awayId, undefined, (m.raw as any)?.homeRank, (m.raw as any)?.awayRank)
          : [];

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
            recommendation: p.expectedValue !== undefined
              ? `Lean ${p.selection} — ${p.expectedValue >= 0 ? "+" : ""}${(p.expectedValue * 100).toFixed(1)}% edge at ${p.marketOdds!.toFixed(2)} odds.`
              : `Lean ${p.selection} (${p.confidence}% model confidence, no market price).`,
            market_odds: p.marketOdds ?? null,
            model_probability: p.modelProbability ?? null,
            expected_value: p.expectedValue ?? null,
          });
        }

        const filteredAll = betType === "all" ? all : all.filter((x) => x.prediction_type === betType);
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

    let noOddsCount = 0;
    let hedgedCount = 0;
    const finalPreds: any[] = [];
    const liveOddsCache = new Map<string, Awaited<ReturnType<typeof fetchLiveOdds>>>();
    for (const p of passedThreshold) {
      const mid = String(p.match_id);
      if (!liveOddsCache.has(mid)) liveOddsCache.set(mid, await fetchLiveOdds(mid));
      const live = liveOddsCache.get(mid);
      const modelProbability = p.model_probability != null ? Number(p.model_probability) : null;

      if (p.prediction_type === "match_winner" && live?.matchWinner && modelProbability != null) {
        const realOdds = p.selection === "Home Win" ? live.matchWinner.oH : live.matchWinner.oA;
        const ev = Math.round((modelProbability * realOdds - 1) * 10000) / 10000;
        let hedged: any = null;
        const lowConfidence = Number(p.confidence) < 60;
        if (lowConfidence && (ev < 0.10 || (ev >= 0.10 && realOdds >= 2.60))) {
          const ah = p.selection === "Home Win" ? live.ahHomePlus : live.ahAwayPlus;
          if (ah) {
            const stats = p.stats ?? {};
            const pWinOrDraw = p.selection === "Home Win"
              ? Number(stats.pH ?? 0) + Number(stats.pD ?? 0)
              : Number(stats.pA ?? 0) + Number(stats.pD ?? 0);
            const ahEv = Math.round((pWinOrDraw * ah.odds - 1) * 10000) / 10000;
            hedged = {
              ...p,
              prediction_type: "match_winner_hedged",
              selection: p.selection === "Home Win" ? "Home +0.5 (AH)" : "Away +0.5 (AH)",
              confidence: Math.round(pWinOrDraw * 1000) / 10,
              market_odds: ah.odds,
              model_probability: pWinOrDraw,
              expected_value: ahEv,
              recommendation: `Hedged ${p.selection === "Home Win" ? "Home" : "Away"} +0.5 AH — ${ahEv >= 0 ? "+" : ""}${(ahEv * 100).toFixed(1)}% edge at ${ah.odds.toFixed(2)} odds (${ah.bookmakers} bookmakers).`,
              stats: { ...(p.stats ?? {}), oddsAvailable: true, hedgedFrom: "match_winner", originalConfidence: p.confidence, originalEv: ev },
            };
            hedgedCount++;
          }
        }
        finalPreds.push(hedged ?? {
          ...p,
          market_odds: realOdds,
          expected_value: ev,
          recommendation: `Lean ${p.selection} — ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}% edge at ${realOdds.toFixed(2)} odds (${live.matchWinner.bookmakers} bookmakers).`,
          stats: { ...(p.stats ?? {}), oddsAvailable: true },
        });
      } else if (p.prediction_type === "over_2_5_goals" && live?.goals25 && modelProbability != null) {
        const ev = Math.round((modelProbability * live.goals25.oOver - 1) * 10000) / 10000;
        finalPreds.push({
          ...p,
          market_odds: live.goals25.oOver,
          expected_value: ev,
          recommendation: `Lean Over 2.5 Goals — ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}% edge at ${live.goals25.oOver.toFixed(2)} odds (${live.goals25.bookmakers} bookmakers @ 2.5 line).`,
          stats: { ...(p.stats ?? {}), oddsAvailable: true },
        });
      } else {
        noOddsCount++;
        finalPreds.push({
          ...p,
          market_odds: null,
          expected_value: null,
          recommendation: `Lean ${p.selection} (${p.confidence}% model confidence, no live market price found for this bet type/line).`,
          stats: { ...(p.stats ?? {}), oddsAvailable: false },
        });
      }
    }
    if (noOddsCount) console.log(`[runAnalysis] ${noOddsCount} picks have no confirmed live market price for their exact bet type`);
    if (hedgedCount) console.log(`[runAnalysis] ${hedgedCount} picks hedged to a real +0.5 Asian Handicap line`);

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

    await lockDailyBestPickIfNeeded();

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
  .inputValidator((d: unknown) => z.object({
    engine: z.enum(["corners", "match"]).optional(),
    page: z.number().int().min(1).optional(),
    pageSize: z.union([z.literal(50), z.literal(100)]).optional(),
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    typeFilter: z.enum(["all", "match_winner", "match_winner_hedged", "over_2_5_goals"]).optional(),
    evFilter: z.enum(["all", "positive", "negative", "20plus", "no_ev"]).optional(),
  }).parse(d ?? {}))
  .handler(async ({ data }) => {
    const page = data.page ?? 1;
    const pageSize = data.pageSize ?? 50;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    let query = supabaseAdmin
      .from("analyses")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false });
    if (data.fromDate) query = query.gte("created_at", `${data.fromDate}T00:00:00.000Z`);
    if (data.toDate) query = query.lte("created_at", `${data.toDate}T23:59:59.999Z`);
    const { data: rows, error, count } = await query.range(from, to);
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
        .select("analysis_id, confidence, is_correct, engine, prediction_type, expected_value")
        .in("analysis_id", ids);
      if (data.engine) pq = pq.eq("engine", data.engine);
      const { data: preds } = await pq;
      const counts: Record<string, { n: number; sum: number; won: number; lost: number; pending: number; matching: number }> = {};
      const typeFilter = data.typeFilter ?? "all";
      const evFilter = data.evFilter ?? "all";
      const matchesFilters = (p: any) => {
        if (typeFilter !== "all" && p.prediction_type !== typeFilter) return false;
        const ev = p.expected_value != null ? Number(p.expected_value) : null;
        switch (evFilter) {
          case "positive": return ev != null && ev >= 0;
          case "negative": return ev != null && ev < 0;
          case "20plus": return ev != null && ev >= 0.20;
          case "no_ev": return ev == null;
          default: return true;
        }
      };
      for (const p of preds ?? []) {
        const k = (p as any).analysis_id;
        counts[k] ??= { n: 0, sum: 0, won: 0, lost: 0, pending: 0, matching: 0 };
        counts[k].n++;
        counts[k].sum += Number((p as any).confidence);
        const ic = (p as any).is_correct;
        if (ic === true) counts[k].won++;
        else if (ic === false) counts[k].lost++;
        else counts[k].pending++;
        if (matchesFilters(p)) counts[k].matching++;
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
            matching_count: counts[a.id].matching,
          }));
      } else {
        analyses = analyses.map((a) => {
          const c = counts[a.id];
          return {
            ...a,
            score_total: c?.n ?? 0,
            score_won: c?.won ?? 0,
            score_pending: c?.pending ?? 0,
            matching_count: c?.matching ?? 0,
          };
        });
      }
    }
    const totalCount = count ?? 0;
    return { analyses, page, pageSize, totalCount, totalPages: Math.max(1, Math.ceil(totalCount / pageSize)) };
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

  const { data: failoverRows } = await supabaseAdmin
    .from("api_usage")
    .select("called_at")
    .eq("endpoint", "__failover")
    .gte("called_at", startOfDay)
    .order("called_at", { ascending: false })
    .limit(1);
  const failoverAt = failoverRows && failoverRows.length ? failoverRows[0].called_at : null;

  const { data: statusRows } = await supabaseAdmin
    .from("api_key_status")
    .select("key_index, exhausted_at, active");
  const k1 = statusRows?.find((r: any) => r.key_index === 1);
  const activeKey: 1 | 2 = k1 && (k1.active === false || k1.exhausted_at) ? 2 : 1;

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

// ---- Single / Combo of the Day ----
// LOCKED the first time a scan produces a qualifying pick for a given day, in
// daily_best_picks — never recomputed/overwritten by a later same-day scan. Without this,
// a pick that already lost could get silently swapped out for a later, still-unresolved
// higher-EV pick, making "Single of the Day: WON" misleading about what was actually
// knowable/committed at the time. Only ever draws from picks with a real, confirmed
// market price, non-negative EV, and at/below the EV ceiling (same discipline as
// elsewhere in this app). Combo is EXPERIMENTAL and tracked completely separately from
// the validated single-pick stats — see the historical numbers from this exact test: a
// daily 3-4 leg Match Winner ACCA went 0/14 winning days despite every leg being
// individually profitable as a single. 2 legs from different matches is the more
// defensible starting point, but this is data-gathering, not a recommendation to stake it.
//
// EV ceiling backtest (graded picks, July 12 onward):
//   10-20% EV  (n=41): 53.7% win rate, +3.0% realized ROI
//   20-35% EV  (n=27): 48.1% win rate, +6.6% realized ROI
//   35-50% EV  (n=6):  50.0% win rate, +22.8% realized ROI  (too small a sample to trust)
//   50%+ EV    (n=27): 25.9% win rate, -10.6% realized ROI  (confirmed collapse zone)
// 40% sits just above the well-performing 20-35% band, captures a modest slice of the
// promising-but-thin 35-50% band, and stays clear of the confirmed 50%+ collapse.
const DAILY_PICK_EV_CEILING = 0.40;
const DAILY_PICK_TYPES = ["match_winner", "over_2_5_goals", "match_winner_hedged"];

/**
 * Locks in Single/Combo of the Day for `today` (UTC) if not already locked. Called once at
 * the end of every successful scan. A no-op if a lock already exists for today — that's
 * the whole point: the FIRST scan of the day that produces a qualifying pick sets it, and
 * it stays fixed regardless of what later scans that same day find.
 */
export async function lockDailyBestPickIfNeeded(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: existingLock } = await supabaseAdmin
    .from("daily_best_picks")
    .select("day")
    .eq("day", today)
    .maybeSingle();
  if (existingLock) return;

  const { data: todaysPicks, error } = await supabaseAdmin
    .from("predictions")
    .select("id, match_id, expected_value")
    .in("prediction_type", DAILY_PICK_TYPES)
    .not("market_odds", "is", null)
    .gte("expected_value", 0)
    .lte("expected_value", DAILY_PICK_EV_CEILING)
    .gte("created_at", `${today}T00:00:00.000Z`)
    .lte("created_at", `${today}T23:59:59.999Z`);
  if (error) { console.warn(`[lockDailyBestPickIfNeeded] query failed: ${error.message}`); return; }
  if (!todaysPicks || !todaysPicks.length) return;

  const bestPerMatch = new Map<string, any>();
  for (const p of todaysPicks) {
    const existing = bestPerMatch.get(p.match_id);
    if (!existing || Number(p.expected_value) > Number(existing.expected_value)) bestPerMatch.set(p.match_id, p);
  }
  const sorted = Array.from(bestPerMatch.values()).sort((a, b) => Number(b.expected_value) - Number(a.expected_value));
  const single = sorted[0];
  const comboLeg2 = sorted[1] ?? null;

  const { error: insertErr } = await supabaseAdmin.from("daily_best_picks").upsert({
    day: today,
    single_prediction_id: single.id,
    combo_prediction_id_1: single.id,
    combo_prediction_id_2: comboLeg2 ? comboLeg2.id : null,
    locked_at: new Date().toISOString(),
  }, { onConflict: "day", ignoreDuplicates: true });
  if (insertErr) console.warn(`[lockDailyBestPickIfNeeded] upsert failed: ${insertErr.message}`);
}

export const getDailyPicks = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(60).optional(),
  }).parse(d ?? {}))
  .handler(async ({ data }) => {
    const page = data.page ?? 1;
    const pageSize = data.pageSize ?? 14;

    const { data: lockRows, error: lockErr, count } = await supabaseAdmin
      .from("daily_best_picks")
      .select("*", { count: "exact" })
      .order("day", { ascending: false })
      .range((page - 1) * pageSize, (page - 1) * pageSize + pageSize - 1);
    if (lockErr) throw new Error(lockErr.message);

    const idsNeeded = new Set<string>();
    for (const l of lockRows ?? []) {
      if (l.single_prediction_id) idsNeeded.add(l.single_prediction_id);
      if (l.combo_prediction_id_1) idsNeeded.add(l.combo_prediction_id_1);
      if (l.combo_prediction_id_2) idsNeeded.add(l.combo_prediction_id_2);
    }
    const { data: predRows } = idsNeeded.size
      ? await supabaseAdmin.from("predictions").select("*").in("id", Array.from(idsNeeded))
      : { data: [] as any[] };
    const byId = new Map((predRows ?? []).map((p: any) => [p.id, p]));

    const days = (lockRows ?? []).map((l) => l.day as string);
    let infoByDay = new Map<string, { qualifying: number; excluded: number }>();
    if (days.length) {
      const minDay = days[days.length - 1], maxDay = days[0];
      const { data: dayPicks } = await supabaseAdmin
        .from("predictions")
        .select("expected_value, created_at")
        .in("prediction_type", DAILY_PICK_TYPES)
        .not("market_odds", "is", null)
        .gte("expected_value", 0)
        .gte("created_at", `${minDay}T00:00:00.000Z`)
        .lte("created_at", `${maxDay}T23:59:59.999Z`);
      for (const p of dayPicks ?? []) {
        const day = new Date(p.created_at).toISOString().slice(0, 10);
        const entry = infoByDay.get(day) ?? { qualifying: 0, excluded: 0 };
        if (Number(p.expected_value) <= DAILY_PICK_EV_CEILING) entry.qualifying++;
        else entry.excluded++;
        infoByDay.set(day, entry);
      }
    }

    const results = (lockRows ?? []).map((l) => {
      const single = l.single_prediction_id ? byId.get(l.single_prediction_id) ?? null : null;
      const leg1 = l.combo_prediction_id_1 ? byId.get(l.combo_prediction_id_1) ?? null : null;
      const leg2 = l.combo_prediction_id_2 ? byId.get(l.combo_prediction_id_2) ?? null : null;
      let combo: any = null;
      if (leg1 && leg2) {
        const legs = [leg1, leg2];
        const bothGraded = legs.every((x) => x.is_correct !== null && x.is_correct !== undefined);
        const won = legs.every((x) => x.is_correct === true);
        const combinedOdds = legs.reduce((s, x) => s * Number(x.market_odds), 1);
        combo = {
          legs,
          combinedOdds: Math.round(combinedOdds * 100) / 100,
          isCorrect: bothGraded ? won : null,
          profit: bothGraded ? Math.round((won ? combinedOdds - 1 : -1) * 100) / 100 : null,
        };
      }
      const info = infoByDay.get(l.day) ?? { qualifying: 0, excluded: 0 };
      return {
        day: l.day,
        single,
        combo,
        qualifyingPicksCount: info.qualifying,
        excludedOutliers: info.excluded,
        lockedAt: l.locked_at,
      };
    });

    const totalCount = count ?? 0;
    return { days: results, totalDays: totalCount, page, pageSize, totalPages: Math.max(1, Math.ceil(totalCount / pageSize)) };
  });
