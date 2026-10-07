import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./admin-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ScanConfig, DEFAULT_SCAN_CONFIG } from "./scan-automation";
const Token = z.object({ accessToken: z.string().min(20) });
export const getScanAutomation = createServerFn({ method: "POST" }).inputValidator((d: unknown) => Token.parse(d)).handler(async ({ data }) => {
  await requireAdmin(data.accessToken);
  const { data: row, error } = await supabaseAdmin.from("engine_settings").select("scan_automation_enabled, scan_automation_config, scan_automation_last_run, scan_automation_status").eq("id", true).single();
  if (error) throw new Error(error.message);
  return { enabled: row.scan_automation_enabled, config: row.scan_automation_config ?? DEFAULT_SCAN_CONFIG, lastRun: row.scan_automation_last_run, status: row.scan_automation_status };
});
export const setScanAutomation = createServerFn({ method: "POST" }).inputValidator((d: unknown) => Token.extend({enabled:z.boolean(), config: ScanConfig}).parse(d)).handler(async ({ data }) => {
  await requireAdmin(data.accessToken);
  const { error } = await supabaseAdmin.from("engine_settings").update({scan_automation_enabled:data.enabled,scan_automation_config:data.config,updated_at:new Date().toISOString()}).eq("id",true);
  if (error) throw new Error(error.message);
  return { ok:true };
});
