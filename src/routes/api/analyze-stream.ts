import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchMatchAnalysis, fetchScheduleByDate, hasMainOdds } from "@/lib/isports.server";
import { gradePrediction as _g, predictCorners, predictMatchOutcomes, meetsConfidenceThreshold } from "@/lib/predictions.server";

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
        const maxPicks = Math.max(1, Math.min(10, Number(url.searchParams.get("maxPicks") ?? 3)));
        const trustedOnly = url.searchParams.get("trustedOnly") !== "false";
        const refresh = url.searchParams.get("refresh") === "true";
        const VALID_BET_TYPES = ["all","match_winner","double_chance","asian_handicap","over_1_5_goals","over_6_5_corners","over_7_5_corners"] as const;
        const rawBet = (url.searchParams.get("betType") ?? "all").toLowerCase();
        const betType = (VALID_BET_TYPES as readonly string[]).includes(rawBet) ? rawBet : "all";
        const cornerTypes = new Set(["over_6_5_corners","over_7_5_corners"]);
        const matchTypes = new Set(["match_winner","double_chance","asian_handicap","over_1_5_goals"]);
        const runCorners = betType === "all" || cornerTypes.has(betType);
        const runMatch = betType === "all" || matchTypes.has(betType);

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

              const initialCandidates = afterTrusted.sort((a, b) => a.matchTime - b.matchTime).slice(0, maxMatches);

              // Dedup: skip matches already predicted (any market).
              let skippedExisting = 0;
              let candidates = initialCandidates;
              if (initialCandidates.length) {
                const ids = initialCandidates.map((c) => String(c.matchId));
                const { data: existing } = await supabaseAdmin
                  .from("predictions")
                  .select("match_id")
                  .in("match_id", ids);
                const existingSet = new Set((existing ?? []).map((r: any) => String(r.match_id)));
                candidates = initialCandidates.filter((c) => !existingSet.has(String(c.matchId)));
                skippedExisting = initialCandidates.length - candidates.length;
                if (skippedExisting) {
                  send("status", { message: `Skipping ${skippedExisting} matches already predicted in a previous scan.` });
                }
              }
              if (!candidates.length) {
                send("error", { message: `All ${initialCandidates.length} qualifying matches were already predicted in earlier scans. Try a different date or timeframe.` });
                controller.close();
                return;
              }
              send("status", {
                message: `Analyzing top ${candidates.length} of ${afterTrusted.length} qualifying matches${skippedExisting ? ` (${skippedExisting} skipped as duplicates)` : ""}.`,
                total: candidates.length,
              });

              const scanStartedAt = new Date().toISOString();

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
                  const corners = runCorners ? predictCorners(analysis, m.homeId, m.awayId) : [];
                  const matchPreds = runMatch ? predictMatchOutcomes(analysis, m.homeId, m.awayId) : [];
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
                  // Restrict to selected bet type if a specific one was chosen.
                  const filtered = betType === "all" ? collected : collected.filter((x) => x.prediction_type === betType);
                  filtered.sort((a, b) => Number(b.confidence) - Number(a.confidence));
                  const best = filtered[0];
                  if (best) {
                    predictions.push({
                      ...best, match_id: m.matchId,
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
              const passedThreshold = predictions
                .filter((p) => meetsConfidenceThreshold(p.prediction_type, Number(p.confidence)))
                .filter((p) => 100 / Number(p.confidence) >= minOdds)
                .sort((a, b) => Number(b.confidence) - Number(a.confidence))
                .slice(0, maxPicks);

              // Bookmaker availability check (after confidence filter to protect API quota).
              let droppedNoOdds = 0;
              const finalPreds: any[] = [];
              for (const p of passedThreshold) {
                const ok = await hasMainOdds(String(p.match_id));
                if (ok) finalPreds.push(p);
                else droppedNoOdds++;
              }
              if (droppedNoOdds) {
                send("status", { message: `Dropped ${droppedNoOdds} pick(s) with no 1X2 bookmaker odds available.` });
              }

              if (!finalPreds.length) {
                send("done", {
                  analysisId: null,
                  matchesAnalyzed: candidates.length,
                  predictionsGenerated: 0,
                  date,
                });
                return;
              }

              const avg = finalPreds.reduce((s, p) => s + Number(p.confidence), 0) / finalPreds.length;
              const distinctLeagues = new Set(
                candidates.map((c) => c.leagueName).filter(Boolean) as string[],
              ).size;

              const { data: analysisRow, error: aErr } = await supabaseAdmin
                .from("analyses")
                .insert({
                  league_id: null,
                  league_name: null,
                  matches_analyzed: candidates.length,
                  predictions_generated: finalPreds.length,
                  avg_confidence: Math.round(avg * 100) / 100,
                  status: "completed",
                  notes: JSON.stringify({ date, timeframeHours, maxMatches, minOdds, trustedOnly, betType, scanStartedAt, distinctLeagues, skippedExisting, droppedNoOdds }),
                })
                .select()
                .single();
              if (aErr || !analysisRow) throw new Error(aErr?.message ?? "analysis insert failed");

              await supabaseAdmin
                .from("predictions")
                .insert(finalPreds.map((p) => ({ ...p, analysis_id: analysisRow.id })));

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
