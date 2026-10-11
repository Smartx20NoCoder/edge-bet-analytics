import {MAX_SCAN_MATCHES} from "@/lib/scan-automation";
import { isCronAuthorized } from "@/lib/cron-auth.server";
import { requireAdmin } from "@/lib/admin-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { matchSavedResult } from "@/lib/goaloo-analysis";
import { fetchMatchAnalysis, fetchScheduleByDate, fetchLiveOdds, setForcedKey } from "@/lib/goaloo.server";
import { goalooOddsAvailability, inQuotedOddsRange, valuePickCounts } from "./goaloo-odds-policy.ts";
import { retryGoaloo } from "./goaloo-retry.ts";
import type { LiveOdds, ScheduleMatch } from "./isports.server";
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
function hasTierNumber(name:string) {
  return /\b[2-9]\b\s*$/.test(name.trim());
}
function isWomensFixture(homeName:string|undefined, awayName:string|undefined) {
  const check = (n:string|undefined) => {
    if (!n) return false;
    const s = n.toLowerCase();
    return /\(w\)\s*$/i.test(n.trim()) || s.includes("women") || s.includes("ladies") || s.includes("féminine") || s.includes("frauen") || s.includes("damen");
  };
  return check(homeName) || check(awayName);
}
const isBlocked = (n:string|undefined) => !n || BLOCKED_KEYWORDS.some((k) => n.toLowerCase().includes(k)) || hasTierNumber(n);
const isTrusted = (n:string|undefined) => {
  if (!n) return false;
  const lower = n.toLowerCase();
  if (MINOR_QUALIFIERS.some((q) => lower.includes(q))) return false;
  if (hasTierNumber(n)) return false;
  return TRUSTED_LEAGUE_PATTERNS.some((p) => lower.includes(p));
};

export type ScanBatch = {processedIds:string[];remaining:number;retryCounts?:Record<string,number>;phase?:'goaloo'|'odds'};
export async function handleAnalyzeStream(request: Request, batch?: ScanBatch) {
        try { if (!isCronAuthorized(request)) await requireAdmin(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? ""); }
        catch { return Response.json({ error: "Administrator access required" }, { status: 401 }); }
        const url = new URL(request.url);
        const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
        const timeframeHours = Number(url.searchParams.get("timeframeHours") ?? 24);
        const maxMatches = Number(url.searchParams.get("maxMatches") ?? MAX_SCAN_MATCHES);
        if (!Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > MAX_SCAN_MATCHES) return Response.json({error:"Choose a whole match limit from 1 to 500."},{status:400});
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
            const send = (event:string, payload:any) => {
              controller.enqueue(encoder.encode(JSON.stringify({ event, ...payload }) + "\n"));
            };

            const requestedEngine = url.searchParams.get("engine") ?? "combined";
            const isportsAvailable = requestedEngine !== "dual_free";
            let summary={matchesAnalyzed:0,predictionsGenerated:0,positiveEvPicks:0,dailyEligibleMatches:0};
            const retryCounts={...batch?.retryCounts};
            const collectionErrors:{matchId:string;stage:string;message:string}[]=[];
            let goalooBatch={processedIds:[] as string[],retryCounts,collectionErrors,checkedForOdds:0,skippedNoOdds:0,insufficientCoverage:0,oddsRequestFailures:0,analysisFailures:0,matchesAnalyzed:0,matchesAttempted:0,positiveEvPicks:0,dailyEligibleMatches:0,poolRemaining:0,pending:false,stopReason:'exhausted'};
            let oddsApiAvailable = false;
            let oddsApiPending=false;
            try {
              oddsApiAvailable = requestedEngine !== "goaloo" && (await getOddsApiKeysStatus()).availableKeys > 0;
            } catch (e:any) {
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
              } catch (e:any) {
                send("status", { message: `Goaloo schedule fetch failed: ${e?.message ?? e}` });
                throw e;
              }
              send("status", { message: `Goaloo returned ${all.length} total fixtures for ${date}.` });

              const now = Date.now();
              const windowStart = Math.max(now, Date.parse(`${date}T00:00:00Z`));
              const windowEnd = windowStart + timeframeHours * 3600 * 1000;

              const futureOnly = all.filter((m) => m.matchTime * 1000 > windowStart);
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
                const existing:{match_id:string|null;home_team:string;away_team:string;kickoff:string|null}[]=[];
                for(let offset=0;;offset+=1000){
                  const {data:page,error:existingError}=await supabaseAdmin.from('predictions').select('match_id,home_team,away_team,kickoff').gte('kickoff',new Date(now).toISOString()).lte('kickoff',new Date(windowEnd).toISOString()).order('id').range(offset,offset+999);
                  if(existingError)throw new Error(`Existing predictions could not be checked: ${existingError.message}`);
                  existing.push(...(page??[]));
                  if(!page||page.length<1000)break;
                }
                const existingSet = new Set((existing ?? []).map((r) => String(r.match_id)));
                dedupedPool = sortedPool.filter((c) => !existingSet.has(String(c.matchId)) && !(existing ?? []).some(p=>matchSavedResult(p,[{matchId:c.matchId,homeName:c.homeName,awayName:c.awayName,kickoff:new Date(c.matchTime*1000).toISOString()}])));
                skippedExisting = sortedPool.length - dedupedPool.length;
                if (skippedExisting) {
                  send("status", { message: `Skipping ${skippedExisting} matches already predicted in a previous scan.` });
                }
              }
              if(batch) dedupedPool=dedupedPool.filter(m=>!batch.processedIds.includes(String(m.matchId)));
              if (!dedupedPool.length) {
                send("status", { message: `Goaloo: all ${sortedPool.length} qualifying matches were already predicted in earlier scans.` });
                return;
              }

              // Each request is bounded; callers persist the cursor and resume. Missing
              // markets, insufficient bookmaker coverage and collection failures are separate.
              const candidates:ScheduleMatch[] = [];
              let skippedNoOdds = 0;
              let checkedForOdds = 0;
              let insufficientCoverage=0,oddsRequestFailures=0,analysisFailures=0;
              const scanDeadline = Date.now()+220000;
              const target=batch ? Math.min(maxMatches,batch.remaining,60) : maxMatches;
              const completedIds=new Set<string>();
              const liveOddsByMatch=new Map<string,LiveOdds>();
              const failedCheck=(id:string)=>{retryCounts[id]=(retryCounts[id]??0)+1;if(retryCounts[id]>=2)completedIds.add(id);};
              for (let offset=0; offset<dedupedPool.length && candidates.length<target && checkedForOdds<Math.max(maxMatches*3,100) && Date.now()<scanDeadline-90000;) {
                const group=dedupedPool.slice(offset,offset+Math.min(3,target-candidates.length));
                offset+=group.length;
                const checks=await Promise.all(group.map(async m=>{
                  checkedForOdds++;
                  try {
                    const odds=await retryGoaloo(()=>fetchLiveOdds(m.matchId),scanDeadline-90000);
                    liveOddsByMatch.set(String(m.matchId),odds);
                    return goalooOddsAvailability(odds,betType);
                  } catch(e:any) {
                    oddsRequestFailures++;failedCheck(String(m.matchId));
                    if(collectionErrors.length<8)collectionErrors.push({matchId:String(m.matchId),stage:'odds',message:String(e.message??'Odds collection failed').slice(0,180)});
                    send("status",{message:`Odds request failed for ${m.homeName} vs ${m.awayName}: ${e.message}. ${completedIds.has(String(m.matchId))?'Retry allowance exhausted.':'Will retry in the next batch.'}`});
                    return 'request_failed';
                  }
                }));
                group.forEach((m,i)=>{
                  if(checks[i]==='available')candidates.push(m);
                  else if(checks[i]!=='request_failed'){
                    if(checks[i]==='insufficient_bookmakers')insufficientCoverage++;else skippedNoOdds++;
                    completedIds.add(String(m.matchId));
                  }
                });
              }
              const updateBatch=(analysed:number,attempted:number)=>{
                const poolRemaining=dedupedPool.filter(m=>!completedIds.has(String(m.matchId))).length;
                const remaining=batch?.remaining??maxMatches;
                goalooBatch={...goalooBatch,processedIds:[...completedIds],retryCounts,checkedForOdds,skippedNoOdds,insufficientCoverage,oddsRequestFailures,analysisFailures,matchesAnalyzed:analysed,matchesAttempted:attempted,poolRemaining,pending:analysed<remaining&&poolRemaining>0,stopReason:analysed>=remaining?'limit_reached':poolRemaining?'continuing':'exhausted'};
              };
              send("status",{message:`Odds checks: ${checkedForOdds} fixtures · ${skippedNoOdds} missing requested markets · ${insufficientCoverage} with fewer than two bookmakers · ${oddsRequestFailures} failed requests · ${candidates.length} priceable matches.`});
              updateBatch(0,0);
              if (!candidates.length) {
                send("status", { message: goalooBatch.pending ? 'Goaloo odds checks will continue in another batch.' : 'Goaloo fixture pool exhausted without additional priceable matches.' });
                return;
              }
              send("status", {
                message: `Analyzing ${candidates.length} matches with live odds (of ${afterTrusted.length} qualifying)${skippedExisting ? `, ${skippedExisting} skipped as duplicates` : ""}${skippedNoOdds ? `, ${skippedNoOdds} skipped (no odds)` : ""}.`,
                total: candidates.length,
              });

              const scanStartedAt = new Date().toISOString();

              const predictions:any[] = [];
              let matchesChecked=0,matchesAttempted=0;
              const seen = new Set();
              const analyzeCandidate = async (i:number) => {
                const m = candidates[i];
                matchesAttempted++;
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
                  const analysis = await retryGoaloo(()=>fetchMatchAnalysis(m.matchId, refresh),scanDeadline);
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
                      ? `Lean ${p.selection} — ${p.expectedValue >= 0 ? "+" : ""}${(p.expectedValue * 100).toFixed(1)}% edge at ${p.marketOdds?.toFixed(2)} odds.`
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
                  matchesChecked++;completedIds.add(String(m.matchId));delete retryCounts[String(m.matchId)];
                  send("match_done", {
                    index: i + 1, total: candidates.length,
                    home: m.homeName, away: m.awayName,
                    picks: kept,
                  });
                } catch (e:any) {
                  analysisFailures++;failedCheck(String(m.matchId));
                  if(collectionErrors.length<8)collectionErrors.push({matchId:String(m.matchId),stage:'analysis',message:String(e.message??'Analysis collection failed').slice(0,180)});
                  send("match_error", {
                    index: i + 1, total: candidates.length,
                    home: m.homeName, away: m.awayName,
                    error: e?.message ?? "failed",
                  });
                }
              };
              for(let i=0;i<candidates.length;i+=3){
                if(Date.now()>=scanDeadline-20000){send("status",{message:"Batch time budget reached. Saving progress before continuing remaining matches."});break;}
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
                .sort((a, b) => {
                  const evA = a.expected_value, evB = b.expected_value;
                  if (evA != null && evB != null) return Number(evB) - Number(evA);
                  if (evA != null) return -1;
                  if (evB != null) return 1;
                  return Number(b.confidence) - Number(a.confidence);
                });

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
                // A fixture may have 1X2 prices but no exact 2.5 total (or vice versa).
                // Save only predictions with a confirmed price for their own market.
                noOddsCount++;
                return null;
              }).filter((p) => p !== null).filter(p=>inQuotedOddsRange(p,minOdds,maxOdds));
              if (noOddsCount) {
                send("status", { message: `${noOddsCount} pick(s) dropped — no confirmed live market price for their exact bet type/line.` });
              }
              if (hedgedCount) {
                send("status", { message: `${hedgedCount} sub-60%-confidence/sub-10%-EV Match Winner pick(s) hedged to a real +0.5 Asian Handicap line.` });
              }

              updateBatch(matchesChecked,matchesAttempted);
              const valueCounts=valuePickCounts(finalPreds);
              goalooBatch={...goalooBatch,...valueCounts};
              summary={matchesAnalyzed:matchesChecked,predictionsGenerated:finalPreds.length,...valueCounts};

              const avg = finalPreds.length ? finalPreds.reduce((s, p) => s + Number(p.confidence), 0) / finalPreds.length : 0;
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
                  notes: JSON.stringify({ engine: "goaloo", date, timeframeHours, maxMatches, minOdds, maxOdds, trustedOnly, betType, scanStartedAt, distinctLeagues, skippedExisting, checkedForOdds, eligibleFixtures:dedupedPool.length, skippedNoOdds, insufficientCoverage,oddsRequestFailures,analysisFailures,collectionErrors,matchesAttempted,...valueCounts,poolRemaining:goalooBatch.poolRemaining,stopReason:goalooBatch.stopReason,noOddsCount, hedgedCount, winRateFloor, drawRateCeil, over25Floor, matchWinnerFloor, doubleChanceFloor, cornersFloor }),
                })
                .select()
                .single();
              if (aErr || !analysisRow) {
                send("status", { message: `Goaloo: failed to save scan: ${aErr?.message ?? "unknown error"}` });
                throw new Error(aErr?.message ?? "Goaloo scan save failed");
              }

              if(finalPreds.length){const {error:predictionError}=await supabaseAdmin
                .from("predictions")
                .insert(finalPreds.map((p) => ({ ...p, analysis_id: analysisRow.id })));
              if(predictionError) throw new Error(`Predictions could not be saved: ${predictionError.message}`);}


              send("status", {
                message: `Goaloo scan complete: ${finalPreds.length} prediction(s) from ${candidates.length} matches.`,
                analysisId: analysisRow.id,
              });
              if (forcedKey) setForcedKey(null);
            }

            try {
              const failures: string[] = [];
              const completedSources: string[] = [];
              if (isportsAvailable && (!batch || batch.remaining>0&&batch.phase!=='odds')) {
                send("status", { message: "— Goaloo statistical scan starting —" });
                try { await runIsportsScan(); completedSources.push("Goaloo"); }
                catch (e:any) {
                  failures.push("Goaloo");
                  // Failed persistence cannot advance a cursor or lock daily picks.
                  goalooBatch={...goalooBatch,processedIds:[],retryCounts:{...batch?.retryCounts},pending:true,matchesAnalyzed:0};
                  summary={matchesAnalyzed:0,predictionsGenerated:0,positiveEvPicks:0,dailyEligibleMatches:0};
                  send("status", { message: `Goaloo batch failed: ${e?.message ?? e}. Saved predictions are retained; this batch must be retried before daily selection.` });
                }
              }
              if(!completedSources.length&&goalooBatch.pending)throw new Error('Goaloo batch did not finish safely. Retry to continue; daily picks have not been selected.');
              if(batch && (batch.remaining<=0||batch.phase==='odds')&&isportsAvailable) completedSources.push("Goaloo");
              if(goalooBatch.oddsRequestFailures||goalooBatch.analysisFailures)failures.push('Goaloo collection warnings');
              // Give the paid source a fresh request budget after Goaloo's final batch.
              oddsApiPending=!!batch&&batch.phase!=='odds'&&isportsAvailable&&oddsApiAvailable&&!goalooBatch.pending&&goalooBatch.matchesAttempted>0;
              if (oddsApiAvailable && !goalooBatch.pending&&!oddsApiPending) {
                send("status", { message: "— Odds API (sharp-vs-soft) scan starting —" });
                try {
                  const result = await runDualFreeScan({
                    timeframeHours, maxMatches, matchWinnerFloor, over25Floor,
                    minOdds, maxOdds, date, betType, deferDailySelection: true,
                    onEvent: (event, payload) => {
                      if (event === "done") return;
                      if (event === "error") {
                        send("status", payload);
                        return;
                      }
                      send(event, payload);
                    },
                  });
                  completedSources.push("Odds API");
                  summary.matchesAnalyzed += result.matchesAnalyzed;
                  summary.predictionsGenerated += result.predictionsGenerated;
                  summary.positiveEvPicks += result.positiveEvPicks??0;
                  summary.dailyEligibleMatches += result.dailyEligibleMatches??0;
                  if(result.failedLeagues?.length)failures.push(`Odds API: ${result.failedLeagues.length} leagues unavailable`);
                } catch (e:any) {
                  failures.push("Odds API");
                  send("status", { message: `Odds API scan failed: ${e?.message ?? e}. Saved Goaloo results are unaffected.` });
                }
              } else if (!goalooBatch.pending&&!oddsApiPending && requestedEngine !== "goaloo") {
                send("status", { message: "No available Odds API key — Goaloo results are retained; configure the Odds API keys in Settings." });
                failures.push("Odds API unavailable");
              }
              send("status", { message: goalooBatch.pending ? 'Goaloo scan is continuing; daily selection waits for the final batch.' : oddsApiPending ? 'Goaloo scan finished. Odds API will run in the next batch before daily selection.' : 'Source phases finished. Selecting Single and Combo of the Day from the shared qualifying pool…' });
              if (completedSources.length && !goalooBatch.pending&&!oddsApiPending) await lockDailyBestPickIfNeeded();
              send("done", { message: goalooBatch.pending||oddsApiPending?'Scan continuing.':failures.length ? "Scan finished with source warnings." : "Scan complete.", ...summary, failures, completedSources, goalooBatch,oddsApiPending });
            } catch (e:any) {
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
}
