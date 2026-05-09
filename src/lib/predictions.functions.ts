import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchMatchAnalysis, fetchSchedule } from "./isports.server";
import { predictCorners, predictMatchOutcomes } from "./predictions.server";

const BLOCKED_KEYWORDS = ["friendly", "u17", "u18", "u19", "u20", "u21", "u23", "youth", "reserve"];

function isBlockedLeague(name?: string) {
  if (!name) return false;
  const n = name.toLowerCase();
  return BLOCKED_KEYWORDS.some((k) => n.includes(k));
}

export const runAnalysis = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({
      leagueId: z.string().optional(),
      maxMatches: z.number().int().min(1).max(40).optional(),
    }).parse(d)
  )
  .handler(async ({ data }) => {
    const leagueId = data.leagueId || "1639";
    const maxMatches = data.maxMatches ?? 20;

    const allMatches = await fetchSchedule({ leagueId });
    const upcoming = allMatches
      .filter((m) => m.matchTime * 1000 >= Date.now() - 30 * 60 * 1000)
      .filter((m) => !isBlockedLeague(m.leagueName))
      .sort((a, b) => a.matchTime - b.matchTime)
      .slice(0, maxMatches);

    const leagueName = upcoming[0]?.leagueName ?? null;

    // Insert analysis row
    const { data: analysisRow, error: aErr } = await supabaseAdmin
      .from("analyses")
      .insert({
        league_id: leagueId,
        league_name: leagueName,
        matches_analyzed: upcoming.length,
        predictions_generated: 0,
        status: "running",
      })
      .select()
      .single();
    if (aErr || !analysisRow) throw new Error(aErr?.message ?? "analysis insert failed");

    const predictions: any[] = [];
    let confSum = 0;

    for (const m of upcoming) {
      try {
        const analysis = await fetchMatchAnalysis(m.matchId);

        // Cache fixture
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

        const corner = predictCorners(analysis);
        const matchPreds = predictMatchOutcomes(analysis);

        const all: any[] = [];
        if (corner) {
          all.push({
            engine: "corners",
            prediction_type: corner.type,
            selection: corner.selection,
            projected_corners: corner.projectedCorners,
            confidence: corner.confidence,
            risk_level: corner.riskLevel,
            reasons: corner.reasons,
            stats: corner.stats,
            recommendation: `Bet ${corner.selection} — projected ${corner.projectedCorners} corners.`,
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

        for (const p of all) {
          predictions.push({
            ...p,
            analysis_id: analysisRow.id,
            match_id: m.matchId,
            home_team: m.homeName,
            away_team: m.awayName,
            league_id: m.leagueId,
            league_name: m.leagueName,
            kickoff: new Date(m.matchTime * 1000).toISOString(),
          });
          confSum += Number(p.confidence);
        }
      } catch (e) {
        console.error(`Match ${m.matchId} failed:`, e);
      }
    }

    // Keep only top 5 corner picks
    const corners = predictions.filter((p) => p.engine === "corners")
      .sort((a, b) => b.confidence - a.confidence).slice(0, 5);
    const matchOnes = predictions.filter((p) => p.engine === "match");
    const finalPreds = [...corners, ...matchOnes];

    if (finalPreds.length) {
      await supabaseAdmin.from("predictions").insert(finalPreds);
    }

    const avg = finalPreds.length ? confSum / predictions.length : null;
    await supabaseAdmin
      .from("analyses")
      .update({
        predictions_generated: finalPreds.length,
        avg_confidence: avg ? Math.round(avg * 100) / 100 : null,
        status: "completed",
      })
      .eq("id", analysisRow.id);

    return { analysisId: analysisRow.id, matchesAnalyzed: upcoming.length, predictionsGenerated: finalPreds.length };
  });

export const getAnalyses = createServerFn({ method: "GET" }).handler(async () => {
  const { data, error } = await supabaseAdmin
    .from("analyses")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return { analyses: data ?? [] };
});

export const getPredictions = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({
      engine: z.enum(["corners", "match"]).optional(),
      analysisId: z.string().optional(),
      leagueId: z.string().optional(),
    }).parse(d ?? {})
  )
  .handler(async ({ data }) => {
    let q = supabaseAdmin.from("predictions").select("*").order("confidence", { ascending: false }).limit(200);
    if (data.engine) q = q.eq("engine", data.engine);
    if (data.analysisId) q = q.eq("analysis_id", data.analysisId);
    if (data.leagueId) q = q.eq("league_id", data.leagueId);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { predictions: rows ?? [] };
  });

export const getDashboardStats = createServerFn({ method: "GET" }).handler(async () => {
  const [{ data: analyses }, { data: predictions }] = await Promise.all([
    supabaseAdmin.from("analyses").select("*").order("created_at", { ascending: false }).limit(20),
    supabaseAdmin.from("predictions").select("league_name, confidence, engine").limit(500),
  ]);
  const matches = (analyses ?? []).reduce((s, a: any) => s + (a.matches_analyzed ?? 0), 0);
  const preds = predictions ?? [];
  const avg = preds.length ? preds.reduce((s: number, p: any) => s + Number(p.confidence), 0) / preds.length : 0;
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
    topLeagues,
    recentAnalyses: analyses ?? [],
  };
});

export const checkApiStatus = createServerFn({ method: "GET" }).handler(async () => {
  const hasKey = Boolean(process.env.ISPORTS_API_KEY);
  let live = false;
  let error: string | null = null;
  if (hasKey) {
    try {
      const res = await fetch(
        `http://api.isportsapi.com/sport/football/schedule?api_key=${process.env.ISPORTS_API_KEY}&leagueId=1639`,
      );
      live = res.ok;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e: any) {
      error = e?.message ?? "fetch failed";
    }
  }
  return { hasKey, live, error };
});
