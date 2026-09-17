import { createFileRoute } from "@tanstack/react-router";
import { updateAllPendingResults } from "@/lib/predictions.functions";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

async function isAuthorized(request: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}

export const Route = createFileRoute("/api/cron/update-results")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await isAuthorized(request))) {
          return new Response("Unauthorized", { status: 401 });
        }

        try {
          const { data: settings, error: settingsError } = await supabaseAdmin
            .from("engine_settings")
            .select("results_automation_enabled, results_automation_interval, results_automation_last_run")
            .eq("id", true)
            .maybeSingle();

          if (settingsError) throw new Error(settingsError.message);

          if (!settings?.results_automation_enabled || settings.results_automation_interval !== "24h") {
            return Response.json({ ok: true, job: "update-results", skipped: true, reason: "automation_disabled" });
          }

          const now = new Date();
          const lastRun = settings.results_automation_last_run ? new Date(settings.results_automation_last_run) : null;
          if (lastRun && now.getTime() - lastRun.getTime() < 23 * 60 * 60 * 1000) {
            return Response.json({ ok: true, job: "update-results", skipped: true, reason: "not_due", lastRun: lastRun.toISOString() });
          }

          const result = await updateAllPendingResults({ data: {} });

          const { error: markError } = await supabaseAdmin
            .from("engine_settings")
            .update({ results_automation_last_run: now.toISOString(), updated_at: now.toISOString() })
            .eq("id", true);
          if (markError) throw new Error(markError.message);

          return Response.json({ ok: true, job: "update-results", automated: true, ...result });
        } catch (error: any) {
          console.error("[cron:update-results] failed", error);
          return Response.json(
            { ok: false, job: "update-results", error: error?.message ?? "unknown error" },
            { status: 500 },
          );
        }
      },
    },
  },
});
