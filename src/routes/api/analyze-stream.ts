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
              if (!process.env.ISPORTS_API_KEY) {
                send("error", { message: "ISPORTS_API_KEY is not configured on the server. Add it as a secret and retry." });
                controller.close();
                return;
              }

              send("status", { message: `Fetching fixtures for ${date}…` });
              let all: Awaited<ReturnType<typeof fetchScheduleByDate>>;
              try {
                all = await fetchScheduleByDate(date);
              } catch (e: any) {
                send("error", { message: `Schedule fetch failed: ${e?.message ?? e}` });
                controller.close();
                return;
              }
              send("status", { message: `iSportsAPI returned ${all.length} total fixtures for ${date}.` });

              const now = Date.now();
              const windowEnd = now + timeframeHours * 3600 * 1000;

              const futureOnly = all.filter((m) => m.matchTime * 1000 > now);
              const inWindow = futureOnly.filter((m) => m.matchTime * 1000 <= windowEnd);
              const afterBlocked = inWindow.filter((m) => !isBlocked(m.leagueName));
              const afterTrusted = trustedOnly ? afterBlocked.filter((m) => isTrusted(m.leagueName)) : afterBlocked;

              send("status", {
                message: `Filter breakdown — total ${all.length} → future ${futureOnly.length} → within ${timeframeHours}h ${inWindow.length} → not youth/friendly ${afterBlocked.length} → ${trustedOnly ? "major leagues" : "all leagues"} ${afterTrusted.length}.`,
              });

              if (!afterTrusted.length) {
                const hint = trustedOnly
                  ? "Try unchecking 'Major leagues only' or widening the timeframe."
                  : "Try widening the timeframe or picking a different date.";
                send("error", { message: `No qualifying matches after filters. ${hint}` });
                controller.close();
                return;
              }

              const candidates = afterTrusted.sort((a, b) => a.matchTime - b.matchTime).slice(0, maxMatches);
              send("status", {
                message: `Analyzing top ${candidates.length} of ${afterTrusted.length} qualifying matches.`,
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
              const seen = new Set<string>();
              for (let i = 0; i < candidates.length; i++) {
                const m = candidates[i];
                if (seen.has(String(m.matchId))) {
                  send("status", { message: `Skipping duplicate match ${m.homeName} vs ${m.awayName}.` });
                  continue;
                }
                seen.add(String(m.matchId));
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
                  const corners = predictCorners(analysis, m.homeId, m.awayId);
                  const matchPreds = predictMatchOutcomes(analysis, m.homeId, m.awayId);
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
                  // One best pick per match: pick highest confidence only.
                  collected.sort((a, b) => Number(b.confidence) - Number(a.confidence));
                  const best = collected[0];
                  if (best) {
                    predictions.push({
                      ...best, analysis_id: analysisRow.id, match_id: m.matchId,
                      home_team: m.homeName, away_team: m.awayName,
                      league_id: m.leagueId, league_name: m.leagueName,
                      kickoff: new Date(m.matchTime * 1000).toISOString(),
                    });
                  }
                  send("match_done", {
                    index: i + 1, total: candidates.length,
                    home: m.homeName, away: m.awayName,
                    picks: best ? 1 : 0,
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
              const finalPreds = predictions.filter((p) => 100 / Number(p.confidence) >= minOdds);
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
