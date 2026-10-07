import { createFileRoute } from "@tanstack/react-router";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { isCronAuthorized } from "@/lib/cron-auth.server";
import { ScanConfig, cronScanParams, watDay } from "@/lib/scan-automation";
import { handleAnalyzeStream } from "@/lib/analyze-stream.server";

export const Route = createFileRoute("/api/cron/auto-scan")({ server: { handlers: { GET: async ({request}) => {
  if (!isCronAuthorized(request)) return Response.json({error:"Unauthorized"},{status:401});
  const now = new Date();
  const runId = crypto.randomUUID();
  let claimed = false;
  try {
    const {data:settings,error} = await supabaseAdmin.from("engine_settings").select("scan_automation_enabled,scan_automation_config,scan_automation_last_run,scan_automation_status").eq("id",true).single();
    if (error) throw new Error(error.message);
    if (!settings.scan_automation_enabled) return Response.json({ok:true,skipped:true,reason:"automation_disabled"});
    const config = ScanConfig.parse(settings.scan_automation_config);
    const prior = settings.scan_automation_status;
    const day = watDay(now);
    if (prior?.day === day && prior?.state === "complete") return Response.json({ok:true,skipped:true,reason:"already_completed_today"});
    if (prior?.state === "running" && now.getTime()-Date.parse(settings.scan_automation_last_run)<15*60*1000) return Response.json({ok:true,skipped:true,reason:"already_running"});
    let claim = supabaseAdmin.from("engine_settings").update({scan_automation_last_run:now.toISOString(),scan_automation_status:{day,runId,state:"running"}}).eq("id",true);
    claim = settings.scan_automation_last_run ? claim.eq("scan_automation_last_run",settings.scan_automation_last_run) : claim.is("scan_automation_last_run",null);
    const {data:rows,error:claimError} = await claim.select("id");
    if (claimError) throw new Error(claimError.message);
    if (!rows?.length) return Response.json({ok:true,skipped:true,reason:"another_run_claimed"});
    claimed = true;
    // Run the same combined handler in-process: one duration budget, no public HTTP hop.
    const url = new URL("/api/analyze-stream",request.url);
    url.search = cronScanParams(config,now).toString();
    const response = await handleAnalyzeStream(new Request(url,{headers:{authorization:request.headers.get("authorization")!}}));
    if (!response.ok) throw new Error(`Scan request failed (${response.status})`);
    const events = (await response.text()).split("\n").filter(Boolean).map(line=>JSON.parse(line));
    const done = events.find(e=>e.event === "done");
    if (!done || (done.failures?.length ?? 0)>0 || events.some(e=>e.event === "error")) throw new Error("Combined scan did not complete both sources; successful checks remain saved");
    const status = {day,runId,state:"complete",completedAt:new Date().toISOString(),matches:done.matchesAnalyzed,picks:done.predictionsGenerated};
    const {error:saveError} = await supabaseAdmin.from("engine_settings").update({scan_automation_status:status}).eq("id",true).eq("scan_automation_status->>runId",runId);
    if (saveError) throw new Error(saveError.message);
    console.log("[cron:auto-scan] complete",status);
    return Response.json({ok:true,job:"auto-scan",...status});
  } catch (error: any) {
    console.error("[cron:auto-scan] failed",error?.message);
    if (claimed) await supabaseAdmin.from("engine_settings").update({scan_automation_status:{day:watDay(now),runId,state:"failed",error:String(error?.message??"Scan failed").slice(0,250)}}).eq("id",true).eq("scan_automation_status->>runId",runId);
    return Response.json({ok:false,job:"auto-scan",error:error?.message??"Scan failed"},{status:500});
  }
} } } });
