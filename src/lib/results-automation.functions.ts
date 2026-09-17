import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./admin-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const Input = z.object({ accessToken: z.string().min(20) });
const Interval = z.enum(["off", "24h"]);

export const getResultsAutomation = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin(data.accessToken);
    const { data: settings, error } = await supabaseAdmin
      .from("engine_settings")
      .select("results_automation_enabled, results_automation_interval, results_automation_last_run")
      .eq("id", true)
      .maybeSingle();
    if (error) throw new Error(error.message);

    const enabled = settings?.results_automation_enabled ?? false;
    return {
      enabled,
      interval: enabled ? "24h" : "off",
      lastRun: settings?.results_automation_last_run ?? null,
    };
  });

export const setResultsAutomation = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => Input.extend({ enabled: z.boolean(), interval: Interval }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin(data.accessToken);
    const enabled = data.enabled && data.interval === "24h";
    const { error } = await supabaseAdmin
      .from("engine_settings")
      .upsert({
        id: true,
        results_automation_enabled: enabled,
        results_automation_interval: enabled ? "24h" : "off",
        updated_at: new Date().toISOString(),
      });
    if (error) throw new Error(error.message);
    return { ok: true, enabled, interval: enabled ? "24h" : "off" };
  });
