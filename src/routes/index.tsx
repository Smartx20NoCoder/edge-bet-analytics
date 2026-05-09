import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getDashboardStats, getPredictions } from "@/lib/predictions.functions";
import { RunAnalysisBar } from "@/components/RunAnalysisBar";
import { PredictionCard, type Prediction } from "@/components/PredictionCard";
import { Activity, BarChart3, Database, Gauge } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard · BetEdge AI" },
      { name: "description", content: "Live football betting analytics dashboard with real iSportsAPI data." },
    ],
  }),
  component: Dashboard,
});

function StatCard({ label, value, sub, Icon }: { label: string; value: string; sub?: string; Icon: any }) {
  return (
    <div className="glass rounded-xl p-5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-neon" />
      </div>
      <div className="mt-2 font-mono text-3xl font-bold">{value}</div>
      {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
    </div>
  );
}

function Dashboard() {
  const stats = useServerFn(getDashboardStats);
  const preds = useServerFn(getPredictions);
  const sQ = useQuery({ queryKey: ["dashboard"], queryFn: () => stats() });
  const pQ = useQuery({ queryKey: ["preds", "all"], queryFn: () => preds({ data: {} }) });
  const top = (pQ.data?.predictions ?? []).slice(0, 6) as Prediction[];

  return (
    <div className="grid-bg">
      <section className="mx-auto max-w-7xl px-4 sm:px-6 pt-10 pb-6">
        <div className="flex items-end justify-between flex-wrap gap-3 mb-6">
          <div>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
              Analytics <span className="text-neon">Terminal</span>
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Real iSportsAPI data · Disciplined 75%+ confidence threshold · No simulations.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Matches Analyzed" value={String(sQ.data?.matchesAnalyzed ?? 0)} Icon={Database} sub={`${sQ.data?.totalScans ?? 0} scans`} />
          <StatCard label="Avg Confidence" value={`${sQ.data?.avgConfidence ?? 0}%`} Icon={Gauge} sub="across all picks" />
          <StatCard label="Active Predictions" value={String(sQ.data?.totalPredictions ?? 0)} Icon={Activity} sub="High-confidence only" />
          <StatCard
            label="Top League"
            value={sQ.data?.topLeagues?.[0]?.name ? sQ.data.topLeagues[0].name.slice(0, 14) : "—"}
            Icon={BarChart3}
            sub={sQ.data?.topLeagues?.[0] ? `${sQ.data.topLeagues[0].avgConfidence}% avg` : "Run a scan to populate"}
          />
        </div>

        <div className="mt-6">
          <RunAnalysisBar />
        </div>

        <div className="mt-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">Latest High-Confidence Picks</h2>
            <span className="text-xs text-muted-foreground">Top {top.length}</span>
          </div>
          {pQ.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : top.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
              {top.map((p) => <PredictionCard key={p.id} p={p} />)}
            </div>
          )}
        </div>

        {sQ.data?.topLeagues?.length ? (
          <div className="mt-10 glass rounded-xl p-5">
            <h3 className="text-sm uppercase tracking-widest text-muted-foreground mb-3">Best Performing Leagues</h3>
            <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              {sQ.data.topLeagues.map((l) => (
                <div key={l.name} className="rounded-lg border border-border p-3 bg-secondary/40">
                  <div className="text-sm font-semibold truncate">{l.name}</div>
                  <div className="text-xs text-muted-foreground">{l.count} picks</div>
                  <div className="font-mono text-neon font-bold mt-1">{l.avgConfidence}%</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="glass rounded-xl p-10 text-center">
      <div className="text-sm text-muted-foreground">No predictions yet. Run an analysis above to pull live fixtures and generate picks.</div>
    </div>
  );
}
