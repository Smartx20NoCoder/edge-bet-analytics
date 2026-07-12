import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { fetchMatchAnalysis, fetchScheduleByDate, fetchLiveOdds, setForcedKey } from "@/lib/isports.server";
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
// Regional/state qualifiers that indicate a lower, non-elite competition even when the
// name contains a trusted-sounding phrase like "premier league" (e.g. Australian state
// NPL comps branded "Queensland Premier League", "Victoria Premier League", etc.).
const MINOR_QUALIFIERS = [
  "queensland", "victoria", "victorian", "new south wales", "western australia",
  "south australia", "tasmania", "northern territory", "capital territory",
  "state league", "npl", "county", "district", "metro",
  // Australian state-league abbreviations — these are the actual strings that show up
  // in league names (e.g. "TAS Premier Championship"), not the spelled-out state name.
  "nsw", "vic", "qld", " sa ", " wa ", "tas", "act", " nt ",
];
// A trailing tier number ("... League 2", "... Premier League 3") is a strong signal of a
// lower division that a loose substring match on "premier league" alone would miss.
function hasTierNumber(name: string): boolean {
  return /\b[2-9]\b\s*$/.test(name.trim());
}
// Women's fixtures aren't reliably flagged by league name alone (e.g. "WK League" doesn't
// say "women") — the marker is usually on the team names instead ("(W)" suffix, etc.).
function isWomensFixture(homeName?: string, awayName?: string): boolean {
  const check = (n?: string) => {
    if (!n) return false;
    const s = n.toLowerCase();
    return /\(w\)\s*$/i.test(n.trim()) || s.includes("women") || s.includes("ladies") || s.includes("féminine") || s.includes("frauen") || s.includes("damen");
  };
  return check(homeName) || check(awayName);
}
const isBlocked = (n?: string) => !n || BLOCKED_KEYWORDS.some((k) => n.toLowerCase().includes(k)) || hasTierNumber(n);
const isTrusted = (n?: string) => {
  if (!n) return false;
  const lower = n.toLowerCase();
  if (MINOR_QUALIFIERS.some((q) => lower.includes(q))) return false;
  if (hasTierNumber(n)) return false;
  return TRUSTED_LEAGUE_PATTERNS.some((p) => lower.includes(p));
};

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
        const VALID_BET_TYPES = ["all","match_winner","over_2_5_goals"] as const;
        const rawBet = (url.searchParams.get("betType") ?? "all").toLowerCase();
        const betType = (VALID_BET_TYPES as readonly string[]).includes(rawBet) ? rawBet : "all";
        // Corners, double chance and Asian handicap removed from the scanner — no real
        // market price exists for any of them in this API's data, so no genuine EV can
        // ever be computed. Focused on match_winner and over_1_5_goals only.
        const runCorners = false;
        const runMatch = true;
        const apiKeyParam = url.searchParams.get("apiKey");
        const forcedKey: 1 | 2 | null = apiKeyParam === "1" ? 1 : apiKeyParam === "2" ? 2 : null;
        const maxOdds = Number(url.searchParams.get("maxOdds") ?? 100);
        const winRateFloor = Math.max(0, Math.min(1, Number(url.searchParams.get("winRateFloor") ?? 0.45)));
        const drawRateCeil = Math.max(0, Math.min(1, Number(url.searchParams.get("drawRateCeil") ?? 0.35)));
        const over25Floor = Math.max(0, Math.min(100, Number(url.searchParams.get("over25Floor") ?? 55)));
        const matchWinnerFloor = Math.max(0, Math.min(100, Number(url.searchParams.get("matchWinnerFloor") ?? 52)));
        const doubleChanceFloor = Math.max(0, Math.min(100, Number(url.searchParams.get("doubleChanceFloor") ?? 65)));
        const cornersFloor = Math.max(0, Math.min(100, Number(url.searchParams.get("cornersFloor") ?? 70)));
        const matchThresholds = { winRateFloor, drawRateCeil, over25Floor, matchWinnerFloor, doubleChanceFloor };
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
              const afterBlocked = inWindow.filter((m) => !isBlocked(m.leagueName) && !isWomensFixture(m.homeName, m.awayName));
              const afterTrusted = trustedOnly ? afterBlocked.filter((m) => isTrusted(m.leagueName)) : afterBlocked;

              send("status", {
                message: `Filter breakdown — total ${all.length} → future ${futureOnly.length} → within ${timeframeHours}h ${inWindow.length} → eligible leagues (no youth/friendly/cup/qualifier/women/etc) ${afterBlocked.length} → ${trustedOnly ? "major leagues" : "all leagues"} ${afterTrusted.length}.`,
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
                  const matchPredsRaw = runMatch ? predictMatchOutcomes(analysis, m.homeId, m.awayId, matchThresholds) : [];
                  // Actually respect the selected Bet Type here — previously this only ran as a
                  // client-side display filter, so a "Match Winner" scan still generated and
                  // saved Over 1.5 Goals picks (and vice versa) even though the UI implied
                  // otherwise. Filter to the chosen type before anything gets pushed/saved.
                  const matchPreds = betType === "all" ? matchPredsRaw : matchPredsRaw.filter((p) => p.type === betType);
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
                    stats: p.stats,
                    // Only match_winner ever has a real expectedValue — see predictions.server.ts.
                    recommendation: p.expectedValue !== undefined
                      ? `Lean ${p.selection} — ${p.expectedValue >= 0 ? "+" : ""}${(p.expectedValue * 100).toFixed(1)}% edge at ${p.marketOdds!.toFixed(2)} odds.`
                      : `Lean ${p.selection} (${p.confidence}% model confidence, no market price).`,
                    market_odds: p.marketOdds ?? null,
                    model_probability: p.modelProbability ?? null,
                    expected_value: p.expectedValue ?? null,
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
              const passedThreshold = predictions
                .filter((p) => {
                  const c = Number(p.confidence);
                  if (p.prediction_type === "over_2_5_goals") return c >= over25Floor;
                  if (p.prediction_type === "match_winner") return c >= matchWinnerFloor;
                  return meetsConfidenceThreshold(p.prediction_type, c);
                })
                .filter((p) => {
                  const implied = 100 / Number(p.confidence);
                  return implied >= minOdds && implied <= maxOdds;
                })
                .sort((a, b) => {
                  // Real edge (expected_value) first when present — this is what "best value" should
                  // mean — falling back to confidence for picks with no computable market price.
                  const evA = a.expected_value, evB = b.expected_value;
                  if (evA != null && evB != null) return Number(evB) - Number(evA);
                  if (evA != null) return -1;
                  if (evB != null) return 1;
                  return Number(b.confidence) - Number(a.confidence);
                });

              // Fetch real live odds once per unique qualifying match (same call budget as
              // the old boolean-only check — fetchLiveOdds shares the same /odds/main cache
              // hasMainOdds used to hit) and use them to compute genuine EV. This is the
              // actual fix for match_winner/over_2_5_goals EV being missing or, worse,
              // silently wrong — see predictions.server.ts for why the old /analysis-based
              // extraction was unreliable.
              const liveOddsByMatch = new Map<string, Awaited<ReturnType<typeof fetchLiveOdds>>>();
              const uniqueMatchIds = Array.from(new Set(passedThreshold.map((p) => String(p.match_id))));
              for (const mid of uniqueMatchIds) {
                liveOddsByMatch.set(mid, await fetchLiveOdds(mid));
              }
              let noOddsCount = 0;
              const finalPreds: any[] = passedThreshold.map((p) => {
                const live = liveOddsByMatch.get(String(p.match_id));
                const modelProbability = p.model_probability != null ? Number(p.model_probability) : null;

                if (p.prediction_type === "match_winner" && live?.matchWinner && modelProbability != null) {
                  const realOdds = p.selection === "Home Win" ? live.matchWinner.oH : live.matchWinner.oA;
                  const ev = Math.round((modelProbability * realOdds - 1) * 10000) / 10000;
                  return {
                    ...p,
                    market_odds: realOdds,
                    expected_value: ev,
                    recommendation: `Lean ${p.selection} — ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}% edge at ${realOdds.toFixed(2)} odds (${live.matchWinner.bookmakers} bookmakers).`,
                    reasons: [...(Array.isArray(p.reasons) ? p.reasons : []), `Live market: H ${live.matchWinner.oH.toFixed(2)} / D ${live.matchWinner.oD.toFixed(2)} / A ${live.matchWinner.oA.toFixed(2)} (${live.matchWinner.bookmakers} bookmakers).`],
                    stats: { ...(p.stats ?? {}), oddsAvailable: true },
                  };
                }
                if (p.prediction_type === "over_2_5_goals" && live?.goals25 && modelProbability != null) {
                  const ev = Math.round((modelProbability * live.goals25.oOver - 1) * 10000) / 10000;
                  return {
                    ...p,
                    market_odds: live.goals25.oOver,
                    expected_value: ev,
                    recommendation: `Lean Over 2.5 Goals — ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}% edge at ${live.goals25.oOver.toFixed(2)} odds (${live.goals25.bookmakers} bookmakers @ 2.5 line).`,
                    reasons: [...(Array.isArray(p.reasons) ? p.reasons : []), `Live market @ 2.5 line: Over ${live.goals25.oOver.toFixed(2)} / Under ${live.goals25.oUnder.toFixed(2)} (${live.goals25.bookmakers} bookmakers).`],
                    stats: { ...(p.stats ?? {}), oddsAvailable: true },
                  };
                }
                // No real live odds found for this pick's market — confidence-only, no EV.
                noOddsCount++;
                return {
                  ...p,
                  market_odds: null,
                  expected_value: null,
                  recommendation: `Lean ${p.selection} (${p.confidence}% model confidence, no live market price found for this bet type/line).`,
                  stats: { ...(p.stats ?? {}), oddsAvailable: false },
                };
              });
              if (noOddsCount) {
                send("status", { message: `${noOddsCount} pick(s) have no confirmed live market price for their exact bet type — confidence only, no EV shown.` });
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
                  notes: JSON.stringify({ date, timeframeHours, maxMatches, minOdds, maxOdds, trustedOnly, betType, scanStartedAt, distinctLeagues, skippedExisting, noOddsCount, winRateFloor, drawRateCeil, over25Floor, matchWinnerFloor, doubleChanceFloor, cornersFloor }),
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
