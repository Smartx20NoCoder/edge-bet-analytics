import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { matchSavedResult } from "@/lib/goaloo-analysis";
import { fetchMatchAnalysis, fetchScheduleByDate, fetchLiveOdds, setForcedKey, hasMainOdds } from "@/lib/goaloo.server";
import { gradePrediction as _g, predictCorners, predictMatchOutcomes, meetsConfidenceThreshold } from "@/lib/predictions.server";
import { lockDailyBestPickIfNeeded } from "@/lib/predictions.functions";
import { runDualFreeScan, getOddsApiKeysStatus } from "@/lib/oddsapi.server";

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
function hasTierNumber(name) {
  return /\b[2-9]\b\s*$/.test(name.trim());
}
function isWomensFixture(homeName, awayName) {
  const check = (n) => {
    if (!n) return false;
    const s = n.toLowerCase();
    return /\(w\)\s*$/i.test(n.trim()) || s.includes("women") || s.includes("ladies") || s.includes("féminine") || s.includes("frauen") || s.includes("damen");
  };
  return check(homeName) || check(awayName);
}
const isBlocked = (n) => !n || BLOCKED_KEYWORDS.some((k) => n.toLowerCase().includes(k)) || hasTierNumber(n);
const isTrusted = (n) => {
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
        const timeframeHours = Number(url.searchParams.get("timeframeHours") ?? 24);
        const maxMatches = Math.max(1, Math.min(100, Number(url.searchParams.get("maxMatches") ?? 100)));
        const minOdds = Number(url.searchParams.get("minOdds") ?? 1);
        const trustedOnly = url.searchParams.get("trustedOnly") !== "false";
        const refresh = url.searchParams.get("refresh") === "true";
        const VALID_BET_TYPES = ["all","match_winner","over_2_5_goals"];
        const rawBet = (url.searchParams.get("betType") ?? "all").toLowerCase();
        const betType = VALID_BET_TYPES.includes(rawBet) ? rawBet : "all";
        const runCorners = false;
        const runMatch = true;
        const apiKeyParam = url.searchParams.get("apiKey");
        const forcedKey = apiKeyParam === "1" ? 1 : apiKeyParam === "2" ? 2 : null;
        const maxOdds = Number(url.searchParams.get("maxOdds") ?? 100);
        const winRateFloor = Math.max(0, Math.min(1, Number(url.searchParams.get("winRateFloor") ?? 0.53)));
        const drawRateCeil = Math.max(0, Math.min(1, Number(url.searchParams.get("drawRateCeil") ?? 0.35)));
        const over25Floor = Math.max(0, Math.min(100, Number(url.searchParams.get("over25Floor") ?? 55)));
        const matchWinnerFloor = Math.max(0, Math.min(100, Number(url.searchParams.get("matchWinnerFloor") ?? 56)));
        const doubleChanceFloor = Math.max(0, Math.min(100, Number(url.searchParams.get("doubleChanceFloor") ?? 65)));
        const cornersFloor = Math.max(0, Math.min(100, Number(url.searchParams.get("cornersFloor") ?? 70)));
        const matchThresholds = { winRateFloor, drawRateCeil, over25Floor, matchWinnerFloor, doubleChanceFloor };
        const cornerThresholds = { cornersFloor };

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (event, payload) => {
              controller.enqueue(encoder.encode(JSON.stringify({ event, ...payload }) + "\n"));
            };

            const requestedEngine = url.searchParams.get("engine") ?? "goaloo";
            const isportsAvailable = requestedEngine !== "dual_free";
            let summary={matchesAnalyzed:0,predictionsGenerated:0};
            let oddsApiAvailable = false;
            try {
              oddsApiAvailable = requestedEngine === "dual_free" && (await getOddsApiKeysStatus()).availableKeys > 0;
            } catch (e) {
              console.warn(`[analyze-stream] odds api key status check failed: ${e?.message ?? e}`);
            }

            if (!isportsAvailable && !oddsApiAvailable) {
              send("error", { message: "No Odds API key is available — configure it in Settings, or run a Goaloo scan." });
              controller.close();
              return;
            }

            async function runIsportsScan() {
              send("status", { message: `Fetching fixtures for ${date}…` });
              let all;
              try {
                all = await fetchScheduleByDate(date);
              } catch (e) {
                send("status", { message: `Goaloo schedule fetch failed: ${e?.message ?? e}` });
                return;
              }
              send("status", { message: `Goaloo returned ${all.length} total fixtures for ${date}.` });

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
                send("status", { message: `Goaloo: no qualifying matches after filters. ${hint}` });
                return;
              }

              const sortedPool = afterTrusted.sort((a, b) => a.matchTime - b.matchTime);

              // Dedup against already-predicted matches across the WHOLE trusted/eligible
              // pool (not just the first maxMatches) — needed now that the odds-check
              // below searches further into the pool to find matches that actually have
              // live odds available.
              let skippedExisting = 0;
              let dedupedPool = sortedPool;
              if (sortedPool.length) {
                const ids = sortedPool.map((c) => String(c.matchId));
                const { data: existing } = await supabaseAdmin
                  .from("predictions")
                  .select("match_id,home_team,away_team,kickoff")
                  .gte("kickoff",new Date(now).toISOString())
                  .lte("kickoff",new Date(windowEnd).toISOString());
                const existingSet = new Set((existing ?? []).map((r) => String(r.match_id)));
                dedupedPool = sortedPool.filter((c) => !existingSet.has(String(c.matchId)) && !(existing ?? []).some(p=>matchSavedResult(p,[{matchId:c.matchId,homeName:c.homeName,awayName:c.awayName,kickoff:new Date(c.matchTime*1000).toISOString()}])));
                skippedExisting = sortedPool.length - dedupedPool.length;
                if (skippedExisting) {
                  send("status", { message: `Skipping ${skippedExisting} matches already predicted in a previous scan.` });
                }
              }
              if (!dedupedPool.length) {
                send("status", { message: `Goaloo: all ${sortedPool.length} qualifying matches were already predicted in earlier scans.` });
                return;
              }

              // Filter out matches with no real live odds BEFORE spending an analysis slot
              // on them. Most Goaloo fixtures on a given day have no odds coverage at
              // all — checking availability up front (instead of only discovering it after
              // full prediction generation, as before) means the maxMatches budget goes to
              // matches that can actually be priced into a real EV pick, not wasted on ones
              // that never could be. Stops as soon as maxMatches odds-covered matches are
              // found, rather than checking the entire remaining pool exhaustively.
              const candidates = [];
              let skippedNoOdds = 0;
              let checkedForOdds = 0;
              const scanDeadline = Date.now()+220000;
              for (let offset=0; offset<dedupedPool.length && candidates.length<maxMatches && checkedForOdds<Math.max(maxMatches*3,100) && Date.now()<scanDeadline-90000; offset+=3) {
                const group=dedupedPool.slice(offset,offset+Math.min(3,maxMatches-candidates.length));
                const checks=await Promise.all(group.map(async m=>{
                  checkedForOdds++;
                  try { return await hasMainOdds(m.matchId); }
                  catch(e:any) { send("status",{message:`Odds unavailable for ${m.homeName} vs ${m.awayName}: ${e.message}`}); return false; }
                }));
                group.forEach((m,i)=>{if(checks[i])candidates.push(m);else skippedNoOdds++;});
              }
              if (skippedNoOdds) {
                send("status", { message: `Skipping ${skippedNoOdds} match(es) with no live odds available (checked ${checkedForOdds} matches to fill ${candidates.length} odds-covered slot${candidates.length === 1 ? "" : "s"}).` });
              }
              if (!candidates.length) {
                send("status", { message: `Goaloo: none of the ${dedupedPool.length} qualifying matches have live odds available right now.` });
                return;
              }
              send("status", {
                message: `Analyzing ${candidates.length} matches with live odds (of ${afterTrusted.length} qualifying)${skippedExisting ? `, ${skippedExisting} skipped as duplicates` : ""}${skippedNoOdds ? `, ${skippedNoOdds} skipped (no odds)` : ""}.`,
                total: candidates.length,
              });

              const scanStartedAt = new Date().toISOString();

              const predictions = [];
              let matchesChecked=0;
              const seen = new Set();
              const analyzeCandidate = async (i:number) => {
                const m = candidates[i];
                matchesChecked++;
                if (seen.has(String(m.matchId))) {
                  send("status", { message: `Skipping duplicate match ${m.homeName} vs ${m.awayName}.` });
                  return;
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
                  const matchPredsRaw = runMatch
                    ? predictMatchOutcomes(analysis, m.homeId, m.awayId, matchThresholds, (m.raw)?.homeRank, (m.raw)?.awayRank)
                    : [];
                  const matchPreds = betType === "all" ? matchPredsRaw : matchPredsRaw.filter((p) => p.type === betType);
                  const collected = [];
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
                    recommendation: p.expectedValue !== undefined
                      ? `Lean ${p.selection} — ${p.expectedValue >= 0 ? "+" : ""}${(p.expectedValue * 100).toFixed(1)}% edge at ${p.marketOdds.toFixed(2)} odds.`
                      : `Lean ${p.selection} (${p.confidence}% model confidence, no market price).`,
                    market_odds: p.marketOdds ?? null,
                    model_probability: p.modelProbability ?? null,
                    expected_value: p.expectedValue ?? null,
                  });
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
                } catch (e) {
                  send("match_error", {
                    index: i + 1, total: candidates.length,
                    home: m.homeName, away: m.awayName,
                    error: e?.message ?? "failed",
                  });
                }
              };
              for(let i=0;i<candidates.length;i+=3){
                if(Date.now()>=scanDeadline){send("status",{message:"Time limit reached. Completed predictions will be saved; run another scan for the remaining matches."});break;}
                await Promise.all(candidates.slice(i,i+3).map((_,j)=>analyzeCandidate(i+j)));
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
                  const evA = a.expected_value, evB = b.expected_value;
                  if (evA != null && evB != null) return Number(evB) - Number(evA);
                  if (evA != null) return -1;
                  if (evB != null) return 1;
                  return Number(b.confidence) - Number(a.confidence);
                });

              const liveOddsByMatch = new Map();
              const uniqueMatchIds = Array.from(new Set(passedThreshold.map((p) => String(p.match_id))));
              for (const mid of uniqueMatchIds) {
                liveOddsByMatch.set(mid, await fetchLiveOdds(mid));
              }
              let noOddsCount = 0;
              let hedgedCount = 0;
              const finalPreds = passedThreshold.map((p) => {
                const live = liveOddsByMatch.get(String(p.match_id));
                const modelProbability = p.model_probability != null ? Number(p.model_probability) : null;

                if (p.prediction_type === "match_winner" && live?.matchWinner && modelProbability != null) {
                  const realOdds = p.selection === "Home Win" ? live.matchWinner.oH : live.matchWinner.oA;
                  const ev = Math.round((modelProbability * realOdds - 1) * 10000) / 10000;
                  const base = {
                    ...p,
                    market_odds: realOdds,
                    expected_value: ev,
                    recommendation: `Lean ${p.selection} — ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}% edge at ${realOdds.toFixed(2)} odds (${live.matchWinner.bookmakers} bookmakers).`,
                    reasons: [...(Array.isArray(p.reasons) ? p.reasons : []), `Live market: H ${live.matchWinner.oH.toFixed(2)} / D ${live.matchWinner.oD.toFixed(2)} / A ${live.matchWinner.oA.toFixed(2)} (${live.matchWinner.bookmakers} bookmakers).`],
                    stats: { ...(p.stats ?? {}), oddsAvailable: true },
                  };
                  const lowConfidence = Number(p.confidence) < 60;
                  const hedgeEligible = lowConfidence && (ev < 0.10 || (ev >= 0.10 && realOdds >= 2.60));
                  if (hedgeEligible) {
                    const ah = p.selection === "Home Win" ? live.ahHomePlus : live.ahAwayPlus;
                    if (ah) {
                      const stats = p.stats ?? {};
                      const pWinOrDraw = p.selection === "Home Win"
                        ? Number(stats.pH ?? 0) + Number(stats.pD ?? 0)
                        : Number(stats.pA ?? 0) + Number(stats.pD ?? 0);
                      const ahEv = Math.round((pWinOrDraw * ah.odds - 1) * 10000) / 10000;
                      hedgedCount++;
                      return {
                        ...base,
                        prediction_type: "match_winner_hedged",
                        selection: p.selection === "Home Win" ? "Home +0.5 (AH)" : "Away +0.5 (AH)",
                        confidence: Math.round(pWinOrDraw * 1000) / 10,
                        market_odds: ah.odds,
                        model_probability: pWinOrDraw,
                        expected_value: ahEv,
                        recommendation: `Hedged ${p.selection === "Home Win" ? "Home" : "Away"} +0.5 AH — ${ahEv >= 0 ? "+" : ""}${(ahEv * 100).toFixed(1)}% edge at ${ah.odds.toFixed(2)} odds (${ah.bookmakers} bookmakers).`,
                        reasons: [
                          ...base.reasons,
                          `Original Match Winner: ${p.confidence}% confidence, ${(ev * 100).toFixed(1)}% EV, ${realOdds.toFixed(2)} odds — ${ev < 0.10 ? "under 60% confidence / under +10% EV" : "under 60% confidence, long odds (≥2.60) despite positive EV"}, so hedged to a real +0.5 Asian Handicap line (win-or-draw) instead.`,
                        ],
                        stats: { ...base.stats, hedgedFrom: "match_winner", originalConfidence: p.confidence, originalEv: ev },
                      };
                    }
                  }
                  return base;
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
                // No real live price found for this pick's exact bet type/line — DROP it
                // entirely rather than saving it with a null price. The pre-scan filter
                // (hasMainOdds) only confirms SOME 1X2 data exists for the match; it can't
                // cheaply confirm 2+ bookmakers agree on a real price, or that anyone
                // quotes exactly the 2.5 total line for Over 2.5 specifically — so this
                // final check is still needed to guarantee every SAVED pick has a real,
                // confirmed price behind it.
                noOddsCount++;
                return null;
              }).filter((p) => p !== null);
              if (noOddsCount) {
                send("status", { message: `${noOddsCount} pick(s) dropped — no confirmed live market price for their exact bet type/line.` });
              }
              if (hedgedCount) {
                send("status", { message: `${hedgedCount} sub-60%-confidence/sub-10%-EV Match Winner pick(s) hedged to a real +0.5 Asian Handicap line.` });
              }

              if (!finalPreds.length) {
                send("status", { message: "Goaloo: no predictions generated this scan." });
                return;
              }

              const avg = finalPreds.reduce((s, p) => s + Number(p.confidence), 0) / finalPreds.length;
              const distinctLeagues = new Set(
                candidates.map((c) => c.leagueName).filter(Boolean),
              ).size;

              const { data: analysisRow, error: aErr } = await supabaseAdmin
                .from("analyses")
                .insert({
                  league_id: null,
                  league_name: null,
                  matches_analyzed: matchesChecked,
                  predictions_generated: finalPreds.length,
                  avg_confidence: Math.round(avg * 100) / 100,
                  status: "completed",
                  notes: JSON.stringify({ engine: "goaloo", date, timeframeHours, maxMatches, minOdds, maxOdds, trustedOnly, betType, scanStartedAt, distinctLeagues, skippedExisting, skippedNoOdds, noOddsCount, hedgedCount, winRateFloor, drawRateCeil, over25Floor, matchWinnerFloor, doubleChanceFloor, cornersFloor }),
                })
                .select()
                .single();
              if (aErr || !analysisRow) {
                send("status", { message: `Goaloo: failed to save scan: ${aErr?.message ?? "unknown error"}` });
                return;
              }

              const {error:predictionError}=await supabaseAdmin
                .from("predictions")
                .insert(finalPreds.map((p) => ({ ...p, analysis_id: analysisRow.id })));
              if(predictionError) throw new Error(`Predictions could not be saved: ${predictionError.message}`);
              summary={matchesAnalyzed:matchesChecked,predictionsGenerated:finalPreds.length};

              await lockDailyBestPickIfNeeded();

              send("status", {
                message: `Goaloo scan complete: ${finalPreds.length} prediction(s) from ${candidates.length} matches.`,
                analysisId: analysisRow.id,
              });
              if (forcedKey) setForcedKey(null);
            }

            try {
              if (isportsAvailable) {
                send("status", { message: "— Goaloo scan starting —" });
                await runIsportsScan();
              } else {
                send("status", { message: "Goaloo not configured — skipping." });
              }

              if (oddsApiAvailable) {
                send("status", { message: "— Odds API (sharp-vs-soft) scan starting —" });
                try {
                  await runDualFreeScan({
                    timeframeHours,
                    maxMatches,
                    matchWinnerFloor,
                    over25Floor,
                    minOdds,
                    maxOdds,
                    onEvent: send,
                  });
                } catch (e) {
                  send("status", { message: `Odds API scan failed: ${e?.message ?? e} — Goaloo results (if any) are unaffected.` });
                }
              } else {
                send("status", { message: "Odds API not configured — skipping." });
              }

              if(isportsAvailable) send("done", { message: "Scan complete.", ...summary });
            } catch (e) {
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
