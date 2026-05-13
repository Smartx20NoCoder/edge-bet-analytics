import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { checkApiStatus } from "@/lib/predictions.functions";
import { CheckCircle2, XCircle, Lock } from "lucide-react";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings · BetEdge AI" },
      { name: "description", content: "iSportsAPI status, integration health, and engine configuration for BetEdge AI." },
      { property: "og:title", content: "Settings · BetEdge AI" },
      { property: "og:description", content: "API status and engine configuration for BetEdge AI." },
      { property: "og:url", content: "/settings" },
    ],
    links: [{ rel: "canonical", href: "/settings" }],
  }),
  component: Settings,
});

function Settings() {
  const fn = useServerFn(checkApiStatus);
  const q = useQuery({ queryKey: ["api-status"], queryFn: () => fn() });
  return (
    <section className="mx-auto max-w-3xl px-4 sm:px-6 py-10 space-y-6">
      <h1 className="text-3xl font-bold">Settings</h1>

      <div className="glass rounded-xl p-6">
        <h2 className="text-sm uppercase tracking-widest text-muted-foreground mb-3">iSportsAPI Status</h2>
        <div className="flex items-center gap-3">
          {q.isLoading ? <span className="text-muted-foreground">Checking…</span> :
           q.data?.live ? <><CheckCircle2 className="text-neon" /> <span className="font-semibold text-neon">Live · API responding</span></> :
           q.data?.hasKey ? <><XCircle className="text-destructive" /> <span className="text-destructive">Key set but request failed: {q.data?.error}</span></> :
           <><XCircle className="text-destructive" /> <span className="text-destructive">No API key configured</span></>}
        </div>
        <div className="mt-4 text-xs text-muted-foreground flex items-start gap-2">
          <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0 text-neon" />
          <span>The iSportsAPI key is stored as a server-side secret and never exposed to the browser. All requests run inside protected server functions.</span>
        </div>
      </div>

      <div className="glass rounded-xl p-6 space-y-2 text-sm">
        <h2 className="text-sm uppercase tracking-widest text-muted-foreground">Engines</h2>
        <p><span className="text-neon font-semibold">Corner Engine</span> — Over 6.5 corners; weighted formula on attacking, conceded, shot-volume and tempo. Threshold: ≥75% confidence and ≥8 projected corners. Top 5 only.</p>
        <p><span className="text-gold font-semibold">Match Outcome Engine</span> — Match winner, double chance, Asian handicap, Over 1.5 goals. Combines form, scoring rates, strength index and Poisson goal model. Threshold: ≥75% confidence; friendlies and youth competitions filtered.</p>
      </div>

      <div className="glass rounded-xl p-6 text-xs text-muted-foreground">
        <p>Data caching: per-match analysis cached server-side for 6 hours to optimize quota.</p>
        <p>Errors are isolated per match — a single bad fixture won't fail an entire scan.</p>
      </div>
    </section>
  );
}
