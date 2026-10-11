import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isCronAuthorized } from "@/lib/cron-auth.server";
import { ScanConfig, cronScanParams, watDay } from "@/lib/scan-automation";
import { handleAnalyzeStream } from "@/lib/analyze-stream.server";

export const Route = createFileRoute("/api/cron/auto-scan")({ server: { handlers: { GET: async ({request}) => {
  if (!isCronAuthorized(request)) return Response.json({error:"Unauthorized"},{status:401});
  if(new URL(request.url).searchParams.get('job')==='telegram-history'){
    const {runTelegramArchiveBatch}=await import('@/lib/telegram-archive.server');
    try{return Response.json({ok:true,job:'telegram-history',...await runTelegramArchiveBatch()});}
    catch{return Response.json({ok:false,error:'History queue unavailable. It will retry automatically.'},{status:500});}
  }
  const now = new Date();
  const runId = crypto.randomUUID();
  let claimed = false;
  let progress:any;
  try {
    const {data:settings,error} = await supabaseAdmin.from("engine_settings").select("scan_automation_enabled,scan_automation_config,scan_automation_last_run,scan_automation_status").eq("id",true).single();
    if (error) throw new Error(error.message);
    if (!settings.scan_automation_enabled) return Response.json({ok:true,skipped:true,reason:"automation_disabled"});
    const config = ScanConfig.parse(settings.scan_automation_config);
    const prior = settings.scan_automation_status as any;
    const day = watDay(now);
    if(Number(new Date(now.getTime()+3600000).toISOString().slice(11,13))<10) return Response.json({ok:true,skipped:true,reason:"before_daily_scan_window"});
    if (prior?.day === day && ["complete", "partial"].includes(prior?.state)) return Response.json({ok:true,skipped:true,reason:"already_completed_today"});
    if (prior?.state === "running" && now.getTime()-Date.parse(settings.scan_automation_last_run??'')<15*60*1000) return Response.json({ok:true,skipped:true,reason:"already_running"});
    progress=prior?.day===day && prior?.progress ? prior.progress : {processedIds:[],matches:0,picks:0,skippedNoOdds:0,windowEnd:new Date(now.getTime()+Math.min(config.timeframeHours,(Date.parse(day+"T00:00:00+01:00")+86400000-now.getTime())/3600000)*3600000).toISOString()};
    let claim = supabaseAdmin.from("engine_settings").update({scan_automation_last_run:now.toISOString(),scan_automation_status:{day,runId,state:"running",progress}}).eq("id",true);
    claim = settings.scan_automation_last_run ? claim.eq("scan_automation_last_run",settings.scan_automation_last_run) : claim.is("scan_automation_last_run",null);
    const {data:rows,error:claimError} = await claim.select("id");
    if (claimError) throw new Error(claimError.message);
    if (!rows?.length) return Response.json({ok:true,skipped:true,reason:"another_run_claimed"});
    claimed = true;
    // Run the same combined handler in-process: one duration budget, no public HTTP hop.
    const url = new URL("/api/analyze-stream",request.url);
    url.search = cronScanParams(config,now).toString();
    if(progress.windowEnd) url.searchParams.set("timeframeHours",String(Math.max(0,(Date.parse(progress.windowEnd)-now.getTime())/3600000)));
    const response = await handleAnalyzeStream(new Request(url,{headers:{authorization:request.headers.get("authorization")!}}), {processedIds:progress.processedIds,retryCounts:progress.retryCounts??{},phase:progress.phase,remaining:Math.max(0,config.maxMatches-(progress.goalooMatches??progress.matches))});
    if (!response.ok) throw new Error(`Scan request failed (${response.status})`);
    const events = (await response.text()).split("\n").filter(Boolean).map(line=>JSON.parse(line));
    const done = events.find(e=>e.event === "done");
    if (!done || events.some(e=>e.event === "error")) throw new Error(events.find(e=>e.event === "error")?.message ?? "Scan ended before completion; successful checks remain saved");
    if (!done.completedSources?.length) throw new Error(`No scan source completed: ${(done.failures ?? []).join(", ") || "source unavailable"}`);
    const failures: string[] = done.failures ?? [];
    const warning = failures.length ? `${done.completedSources.join(" and ")} completed; ${failures.join(", ")}. Saved predictions and daily picks are retained.${failures.includes("Odds API unavailable") ? " Add a working Odds API key or renew its quota in Settings to scan that source." : " Check source availability before a manual retry."}` : undefined;
    const nextProgress={windowEnd:progress.windowEnd,processedIds:[...new Set([...progress.processedIds,...(done.goalooBatch?.processedIds??[])])],retryCounts:done.goalooBatch?.retryCounts??progress.retryCounts??{},goalooMatches:(progress.goalooMatches??progress.matches)+(done.goalooBatch?.matchesAnalyzed??done.matchesAnalyzed??0),matches:progress.matches+(done.matchesAnalyzed??0),picks:progress.picks+(done.predictionsGenerated??0),skippedNoOdds:progress.skippedNoOdds+(done.goalooBatch?.skippedNoOdds??0),insufficientCoverage:(progress.insufficientCoverage??0)+(done.goalooBatch?.insufficientCoverage??0),oddsRequestFailures:(progress.oddsRequestFailures??0)+(done.goalooBatch?.oddsRequestFailures??0),analysisFailures:(progress.analysisFailures??0)+(done.goalooBatch?.analysisFailures??0),positiveEvPicks:(progress.positiveEvPicks??0)+(done.positiveEvPicks??0),dailyEligibleMatches:(progress.dailyEligibleMatches??0)+(done.dailyEligibleMatches??0)};
    const pending=done.goalooBatch?.pending===true||done.oddsApiPending===true;
    const nextPhase=done.oddsApiPending?'odds':'goaloo';
    Object.assign(nextProgress,{phase:nextPhase});
    const status = {day,runId,state:pending ? "queued" : failures.length||nextProgress.oddsRequestFailures||nextProgress.analysisFailures ? "partial" : "complete",phase:nextPhase,completedSources:done.completedSources,failures,warning,completedAt:pending ? undefined : new Date().toISOString(),matches:nextProgress.matches,picks:nextProgress.picks,goalooMatches:nextProgress.goalooMatches,checkedFixtures:nextProgress.processedIds.length,skippedNoOdds:nextProgress.skippedNoOdds,insufficientCoverage:nextProgress.insufficientCoverage,oddsRequestFailures:nextProgress.oddsRequestFailures,analysisFailures:nextProgress.analysisFailures,positiveEvPicks:nextProgress.positiveEvPicks,dailyEligibleMatches:nextProgress.dailyEligibleMatches,poolRemaining:done.goalooBatch?.poolRemaining??0,stopReason:done.goalooBatch?.stopReason,collectionErrors:done.goalooBatch?.collectionErrors??[],progress:nextProgress};
    const {error:saveError} = await supabaseAdmin.from("engine_settings").update({scan_automation_status:status}).eq("id",true).eq("scan_automation_status->>runId",runId);
    if (saveError) throw new Error(saveError.message);
    console.log("[cron:auto-scan] batch saved",{...status,progress:undefined});
    return Response.json({ok:true,job:"auto-scan",...status});
  } catch (error: any) {
    console.error("[cron:auto-scan] failed",error?.message);
    if (claimed) await supabaseAdmin.from("engine_settings").update({scan_automation_status:{day:watDay(now),runId,state:"failed",progress,error:String(error?.message??"Scan failed").slice(0,250)}}).eq("id",true).eq("scan_automation_status->>runId",runId);
    return Response.json({ok:false,job:"auto-scan",error:error?.message??"Scan failed"},{status:500});
  }
} } } });
