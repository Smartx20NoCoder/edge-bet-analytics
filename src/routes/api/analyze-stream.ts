import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchMatchAnalysis, fetchScheduleByDate } from "@/lib/isports.server";
import { gradePrediction as _g, predictCorners, predictMatchOutcomes } from "@/lib/predictions.server";

const BLOCKED_KEYWORDS = ["friendly", "u17", "u18", "u19", "u20", "u21", "u23", "youth", "reserve", "women"];
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
const isBlocked = (n?: string) => !n || BLOCKED_KEYWORDS.some((k) => n.toLowerCase().includes(k));
const isTrusted = (n?: string) => !!n && TRUSTED_LEAGUE_PATTERNS.some((p) => n.toLowerCase().includes(p));

export const Route = createFileRoute("/api/analyze-stream")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
        const timeframeHours = Number(url.searchParams.get("timeframeHours") ?? 6);
        const maxMatches = Number(url.searchParams.get("maxMatches") ?? 15);
        const minOdds = Number(url.searchParams.get("minOdds") ?? 1);
        const trustedOnly = url.searchParams.get("trustedOnly") !== "false";
        const refresh = url.searchParams.get("refresh") === "true";

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (event: string, payload: any) => {
              controller.enqueue(encoder.encode(JSON.stringify({ event, ...payload }) + "\n"));
            };
            try {
              send("status", { message: `Fetching fixtures for ${date}…` });
              const all = await fetchScheduleByDate(date);
              const now = Date.now();
              const windowEnd = now + timeframeHours * 3600 * 1000;
              const candidates = all
                .filter((m) => m.matchTime * 1000 > now && m.matchTime * 1000 <= windowEnd)
                .filter((m) => !isBlocked(m.leagueName))
                .filter((m) => (trustedOnly ? isTrusted(m.leagueName) : true))
                .sort((a, b) => a.matchTime - b.matchTime)
                .slice(0, maxMatches);

              send("status", {
                message: `Found ${candidates.length} qualifying matches (from ${all.length} total fixtures).`,
                total: candidates.length,
              });

              const leagueName = candidates[0]?.leagueName ?? null;
              const { data: analysisRow, error: aErr } = await supabaseAdmin
                .from("analyses")
                .insert({
                  league_id: null,
                  league_name: leagueName,
                  matches_analyzed: candidates.length,
                  predictions_generated: 0,
                  status: "running",
                  notes: JSON.stringify({ date, timeframeHours, maxMatches, minOdds, trustedOnly }),
                })
                .select()
                .single();
              if (aErr || !analysisRow) throw new Error(aErr?.message ?? "analysis insert failed");

              const predictions: any[] = [];
              for (let i = 0; i < candidates.length; i++) {
                const m = candidates[i];
                send("match", {
                  index: i + 1,
                  total: candidates.length,
                  home: m.homeName,
                  away: m.awayName,
                  league: m.leagueName ?? "Unknown league",
                  matchId: m.matchId,
                });
                try {
                  const analysis = await fetchMatchAnalysis(m.matchId, refresh);
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
                  const corners = predictCorners(analysis);
                  const matchPreds = predictMatchOutcomes(analysis);
                  const collected: any[] = [];
                  for (const c of corners) collected.push({
                    engine: "corners", prediction_type: c.type, selection: c.selection,
                    projected_corners: c.projectedCorners, confidence: c.confidence,
                    risk_level: c.riskLevel, reasons: c.reasons, stats: c.stats,
                    recommendation: `Bet ${c.selection} — projected ${c.projectedCorners} corners.`,
                  });
                  for (const p of matchPreds) collected.push({
                    engine: "match", prediction_type: p.type, selection: p.selection,
                    confidence: p.confidence, risk_level: p.riskLevel, reasons: p.reasons,
                    stats: p.stats, recommendation: `Lean ${p.selection} (${p.confidence}% model confidence).`,
                  });
                  for (const p of collected) {
                    predictions.push({
                      ...p, analysis_id: analysisRow.id, match_id: m.matchId,
                      home_team: m.homeName, away_team: m.awayName,
                      league_id: m.leagueId, league_name: m.leagueName,
                      kickoff: new Date(m.matchTime * 1000).toISOString(),
                    });
                  }
                  send("match_done", {
                    index: i + 1, total: candidates.length,
                    home: m.homeName, away: m.awayName,
                    picks: collected.length,
                  });
                } catch (e: any) {
                  send("match_error", {
                    index: i + 1, total: candidates.length,
                    home: m.homeName, away: m.awayName,
                    error: e?.message ?? "failed",
                  });
                }
              }

              send("status", { message: "Generating final predictions…" });
              const oddsFiltered = predictions.filter((p) => 100 / Number(p.confidence) >= minOdds);
              const byType: Record<string, any[]> = {};
              for (const p of oddsFiltered) (byType[p.prediction_type] ??= []).push(p);
              const finalPreds: any[] = [];
              for (const arr of Object.values(byType)) {
                arr.sort((a, b) => b.confidence - a.confidence);
                finalPreds.push(...arr.slice(0, 5));
              }
              if (finalPreds.length) await supabaseAdmin.from("predictions").insert(finalPreds);
              const avg = finalPreds.length
                ? finalPreds.reduce((s, p) => s + Number(p.confidence), 0) / finalPreds.length
                : null;
              await supabaseAdmin
                .from("analyses")
                .update({
                  predictions_generated: finalPreds.length,
                  avg_confidence: avg ? Math.round(avg * 100) / 100 : null,
                  status: "completed",
                })
                .eq("id", analysisRow.id);

              send("done", {
                analysisId: analysisRow.id,
                matchesAnalyzed: candidates.length,
                predictionsGenerated: finalPreds.length,
                date,
              });
            } catch (e: any) {
              send("error", { message: e?.message ?? "scan failed" });
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
          },
        });
      },
    },
  },
});
