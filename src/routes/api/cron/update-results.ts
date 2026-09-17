import { createFileRoute } from "@tanstack/react-router";
import { updateAllPendingResults } from "@/lib/predictions.functions";

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export const Route = createFileRoute("/api/cron/update-results")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthorized(request)) {
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
