import { createFileRoute } from "@tanstack/react-router";
import { updateAllPendingResults } from "@/lib/predictions.functions";

const SUPABASE_CRON_TOKEN_HASH = "f78e5efee2861b96a40be1a34e98778a4992d4b085d1a6e0067db48ed80fb049";

async function matchesSupabaseCronToken(token: string): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hash === SUPABASE_CRON_TOKEN_HASH;
}

async function isAuthorized(request: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return true;

  const token = request.headers.get("x-edge-cron-token");
  return token ? matchesSupabaseCronToken(token) : false;
}

export const Route = createFileRoute("/api/cron/update-results")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await isAuthorized(request))) {
          return new Response("Unauthorized", { status: 401 });
        }

        try {
          const result = await updateAllPendingResults({ data: {} });
          return Response.json({ ok: true, job: "update-results", ...result });
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
