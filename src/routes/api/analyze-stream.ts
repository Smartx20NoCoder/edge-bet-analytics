import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchMatchAnalysis, fetchScheduleByDate, hasMainOdds, setForcedKey } from "@/lib/isports.server";
import { gradePrediction as _g, predictCorners, predictMatchOutcomes, meetsConfidenceThreshold } from "@/lib/predictions.server";

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
const isBlocked = (n?: string) => !n || BLOCKED_KEYWORDS.some((k) => n.toLowerCase().includes(k));
const isTrusted = (n?: string) => !!n && TRUSTED_LEAGUE_PATTERNS.some((p) => n.toLowerCase().includes(p));

export const Route = createFileRoute("/api/analyze-stream")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
        const timeframeHours = Number(url.searchParams.get("timeframeHours") ?? 12);
        const maxMatches = Math.max(1, Math.min(80, Number(url.searchParams.get("maxMatches") ?? 50)));
        const minOdds = Number(url.searchParams.get("minOdds") ?? 1);
        const trustedOnly = url.searchParams.get("trustedOnly") !== "false";
        const refresh = url.searchParams.get("refresh") === "true";
        const VALID_BET_TYPES = ["all","match_winner","double_chance","asian_handicap","over_1_5_goals","over_6_5_corners","over_7_5_corners","over_8_5_corners"] as const;
        const rawBet = (url.searchParams.get("betType") ?? "all").toLowerCase();
        const betType = (VALID_BET_TYPES as readonly string[]).includes(rawBet) ? rawBet : "all";
        // Always run all engines; the betType is only used as an optional cell filter on the client.
        const runCorners = true;
        const runMatch = true;
        const apiKeyParam = url.searchParams.get("apiKey");
        const forcedKey: 1 | 2 | null = apiKeyParam === "1" ? 1 : apiKeyParam === "2" ? 2 : null;
        const maxOdds = Number(url.searchParams.get("maxOdds") ?? 100);
        const winRateFloor = Math.max(0, Math.min(1, Number(url.searchParams.get("winRateFloor") ?? 0.45)));
        const drawRateCeil = Math.max(0, Math.min(1, Number(url.searchParams.get("drawRateCeil") ?? 0.35)));
        const over15Floor = Math.max(0, Math.min(100, Number(url.searchParams.get("over15Floor") ?? 60)));
        const matchWinnerFloor = Math.max(0, Math.min(100, Number(url.searchParams.get("matchWinnerFloor") ?? 52)));
        const doubleChanceFloor = Math.max(0, Math.min(100, Number(url.searchParams.get("doubleChanceFloor") ?? 65)));
        const cornersFloor = Math.max(0, Math.min(100, Number(url.searchParams.get("cornersFloor") ?? 70)));
        const matchThresholds = { winRateFloor, drawRateCeil, over15Floor, matchWinnerFloor, doubleChanceFloor };
        const cornerThresholds = { cornersFloor };

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
              if (forcedKey) {
                setForcedKey(forcedKey);
                send("status", { message: `Using API Key ${forcedKey} only (manual override — failover disabled).` });
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
                message: `Filter breakdown — total ${all.length} → future ${futureOnly.length} → within ${timeframeHours}h ${inWindow.length} → eligible leagues (no youth/friendly/cup/qualifier/etc) ${afterBlocked.length} → ${trustedOnly ? "major leagues" : "all leagues"} ${afterTrusted.length}.`,
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
                  const corners = runCorners ? predictCorners(analysis, m.homeId, m.awayId, cornerThresholds) : [];
                  const matchPreds = runMatch ? predictMatchOutcomes(analysis, m.homeId, m.awayId, matchThresholds) : [];
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
                  // Keep ALL qualifying picks across all 4 engines for this match.
                  // betType is no longer used to restrict storage — clients filter per-cell in the table.
                  let kept = 0;
                  for (const x of collected) {
                    predictions.push({
                      ...x, match_id: m.matchId,
                      home_team: m.homeName, away_team: m.awayName,
                      league_id: m.leagueId, league_name: m.leagueName,
                      kickoff: new Date(m.matchTime * 1000).toISOString(),
                    });
                    kept++;
                  }
                  send("match_done", {
                    index: i + 1, total: candidates.length,
                    home: m.homeName, away: m.awayName,
                    picks: kept,
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
              const isCorner = (t: string) => t === "over_6_5_corners" || t === "over_7_5_corners" || t === "over_8_5_corners";
              const passedThreshold = predictions
                .filter((p) => {
                  const c = Number(p.confidence);
                  if (p.prediction_type === "over_1_5_goals") return c >= over15Floor;
                  if (p.prediction_type === "match_winner") return c >= matchWinnerFloor;
                  if (p.prediction_type === "double_chance") return c >= doubleChanceFloor;
                  if (isCorner(p.prediction_type)) return c >= cornersFloor;
                  return meetsConfidenceThreshold(p.prediction_type, c);
                })
                .filter((p) => {
                  const implied = 100 / Number(p.confidence);
                  return implied >= minOdds && implied <= maxOdds;
                })
                .sort((a, b) => Number(b.confidence) - Number(a.confidence));

              // Bookmaker availability check — one call per unique match, cached + annotated.
              const oddsByMatch = new Map<string, boolean>();
              const uniqueMatchIds = Array.from(new Set(passedThreshold.map((p) => String(p.match_id))));
              for (const mid of uniqueMatchIds) {
                oddsByMatch.set(mid, await hasMainOdds(mid));
              }
              let noOddsCount = 0;
              const finalPreds: any[] = passedThreshold.map((p) => {
                const ok = oddsByMatch.get(String(p.match_id)) ?? true;
                if (!ok) noOddsCount++;
                return { ...p, stats: { ...(p.stats ?? {}), oddsAvailable: ok } };
              });
              if (noOddsCount) {
                send("status", { message: `Flagged ${noOddsCount} pick(s) with no 1X2 bookmaker odds — verify manually.` });
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
                  notes: JSON.stringify({ date, timeframeHours, maxMatches, minOdds, maxOdds, trustedOnly, betType, scanStartedAt, distinctLeagues, skippedExisting, noOddsCount, winRateFloor, drawRateCeil, over15Floor, matchWinnerFloor, doubleChanceFloor, cornersFloor }),
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
              if (forcedKey) setForcedKey(null);
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
