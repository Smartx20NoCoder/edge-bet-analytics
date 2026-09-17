import { createFileRoute } from "@tanstack/react-router";

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

export const Route = createFileRoute("/api/cron/auto-scan")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!(await isAuthorized(request))) {
          return new Response("Unauthorized", { status: 401 });
        }

        // Mirror the dashboard's normal scan configuration, with the user's requested
        // unattended default of "all eligible leagues" rather than "major leagues only".
        // We intentionally omit apiKey so the existing iSports key failover remains active.
        const origin = new URL(request.url).origin;
        const params = new URLSearchParams({
          timeframeHours: "12",
          maxMatches: "80",
          minOdds: "1.5",
          maxOdds: "3.5",
          trustedOnly: "false",
          refresh: "false",
          betType: "all",
        });

        try {
          const response = await fetch(`${origin}/api/analyze-stream?${params.toString()}`, {
            method: "GET",
            headers: { "Cache-Control": "no-cache" },
          });

          if (!response.ok) {
            const body = await response.text();
            return Response.json(
              { ok: false, job: "auto-scan", status: response.status, error: body || response.statusText },
              { status: 502 },
            );
          }

          // The scan endpoint streams NDJSON progress events. The cron job must consume
          // the whole stream so the underlying scan is allowed to finish before the cron
          // invocation returns.
          const body = await response.text();
          const events = body
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              try { return JSON.parse(line); } catch { return null; }
            })
            .filter(Boolean) as any[];

          const done = events.find((e) => e.event === "done");
          const errors = events.filter((e) => e.event === "error" || e.event === "match_error");
          const statuses = events.filter((e) => e.event === "status");

          return Response.json({
            ok: errors.length === 0,
            job: "auto-scan",
            done: !!done,
            errors: errors.length,
            statusEvents: statuses.length,
            lastStatus: statuses.at(-1)?.message ?? null,
          });
        } catch (error: any) {
          console.error("[cron:auto-scan] failed", error);
          return Response.json(
            { ok: false, job: "auto-scan", error: error?.message ?? "unknown error" },
            { status: 500 },
          );
        }
      },
    },
  },
});
