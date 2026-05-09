import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getAnalyses, getPredictions } from "@/lib/predictions.functions";
import { useState, useMemo } from "react";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { PredictionCard, type Prediction } from "@/components/PredictionCard";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "Analysis History · BetEdge AI" },
      { name: "description", content: "Browse previous prediction scans with full reasoning and confidence trail." },
    ],
  }),
  component: HistoryPage,
});

function HistoryPage() {
  const fa = useServerFn(getAnalyses);
  const fp = useServerFn(getPredictions);
  const aQ = useQuery({ queryKey: ["analyses"], queryFn: () => fa() });
  const [openId, setOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const list = useMemo(() => {
    const items = aQ.data?.analyses ?? [];
    if (!search) return items;
    const s = search.toLowerCase();
    return items.filter((a: any) =>
      (a.league_name ?? "").toLowerCase().includes(s) ||
      (a.scan_date ?? "").includes(s),
    );
  }, [aQ.data, search]);

  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 py-10">
      <h1 className="text-3xl font-bold">Analysis <span className="text-neon">History</span></h1>
      <p className="text-sm text-muted-foreground mt-1">Persistent record of every scan, with full reasoning.</p>

      <div className="mt-6 glass rounded-xl p-3 flex items-center gap-2">
        <Search className="h-4 w-4 text-muted-foreground ml-2" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by league or date (YYYY-MM-DD)…"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground py-2"
        />
      </div>

      <div className="mt-6 space-y-2">
        {aQ.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!aQ.isLoading && list.length === 0 && (
          <div className="glass rounded-xl p-10 text-center text-sm text-muted-foreground">No analyses yet.</div>
        )}
        {list.map((a: any) => (
          <HistoryItem
            key={a.id}
            a={a}
            open={openId === a.id}
            onToggle={() => setOpenId((o) => (o === a.id ? null : a.id))}
            fp={fp}
          />
        ))}
      </div>
    </section>
  );
}

function HistoryItem({ a, open, onToggle, fp }: any) {
  const q = useQuery({
    queryKey: ["preds", "analysis", a.id],
    queryFn: () => fp({ data: { analysisId: a.id } }),
    enabled: open,
  });
  const preds = (q.data?.predictions ?? []) as Prediction[];
  return (
    <div className="glass rounded-xl">
      <button onClick={onToggle} className="w-full flex items-center gap-3 p-4 text-left">
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <div className="flex-1 min-w-0">
          <div className="font-semibold">{a.league_name ?? "League " + (a.league_id ?? "")}</div>
          <div className="text-xs text-muted-foreground">{new Date(a.created_at).toLocaleString()} · {a.scan_date}</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">{a.matches_analyzed} matches · {a.predictions_generated} picks</div>
          {a.avg_confidence != null && <div className="font-mono text-neon font-bold">{a.avg_confidence}%</div>}
        </div>
      </button>
      {open && (
        <div className="border-t border-border p-4">
          {q.isLoading ? <p className="text-sm text-muted-foreground">Loading picks…</p> :
           preds.length === 0 ? <p className="text-sm text-muted-foreground">No picks for this scan.</p> :
           <div className="grid md:grid-cols-2 gap-4">{preds.map((p) => <PredictionCard key={p.id} p={p} />)}</div>}
        </div>
      )}
    </div>
  );
}
