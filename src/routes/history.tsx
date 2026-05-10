import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getAnalyses, getPredictions, updateAllPendingResults } from "@/lib/predictions.functions";
import { useState, useMemo } from "react";
import { ChevronDown, ChevronRight, Loader2, RefreshCw, Search } from "lucide-react";
import { PredictionCard, type Prediction } from "@/components/PredictionCard";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "Analysis History · BetEdge AI" },
      { name: "description", content: "Browse previous prediction scans with full reasoning and confidence trail." },
    ],
  }),
  component: HistoryPage,
});

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function formatScanLabel(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mon = MONTHS[d.getMonth()];
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${dd} ${mon} ${yyyy} · ${hh}:${mm}`;
}

const TYPE_FILTERS = [
  { id: "all", label: "All" },
  { id: "over_6_5_corners", label: "Corners 6.5" },
  { id: "over_7_5_corners", label: "Corners 7.5" },
  { id: "match_winner", label: "Match Winner" },
  { id: "double_chance", label: "Double Chance" },
  { id: "asian_handicap", label: "Asian Handicap" },
  { id: "over_1_5_goals", label: "Over 1.5" },
];

function HistoryPage() {
  const fa = useServerFn(getAnalyses);
  const fp = useServerFn(getPredictions);
  const aQ = useQuery({ queryKey: ["analyses"], queryFn: () => fa() });
  const [openId, setOpenId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  const list = useMemo(() => {
    const items = aQ.data?.analyses ?? [];
    if (!search) return items;
    const s = search.toLowerCase();
    return items.filter((a: any) =>
      (a.scan_date ?? "").includes(s) ||
      new Date(a.created_at).toLocaleString().toLowerCase().includes(s),
    );
  }, [aQ.data, search]);

  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 py-10">
      <h1 className="text-3xl font-bold">Analysis <span className="text-neon">History</span></h1>
      <p className="text-sm text-muted-foreground mt-1">Persistent record of every scan. Update FT results without re-running predictions.</p>

      <div className="mt-6 glass rounded-xl p-3 flex items-center gap-2">
        <Search className="h-4 w-4 text-muted-foreground ml-2" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by date (YYYY-MM-DD or formatted)…"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground py-2"
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {TYPE_FILTERS.map((f) => (
          <button key={f.id} onClick={() => setTypeFilter(f.id)}
            className={`px-3 h-8 rounded-md text-xs border ${typeFilter === f.id ? "bg-neon/15 border-neon/40 text-neon" : "border-border text-muted-foreground hover:text-foreground"}`}>
            {f.label}
          </button>
        ))}
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
            typeFilter={typeFilter}
          />
        ))}
      </div>
    </section>
  );
}

function HistoryItem({ a, open, onToggle, fp, typeFilter }: any) {
  const qc = useQueryClient();
  const update = useServerFn(updateResults);
  const q = useQuery({
    queryKey: ["preds", "analysis", a.id],
    queryFn: () => fp({ data: { analysisId: a.id } }),
    enabled: open,
  });
  const m = useMutation({
    mutationFn: () => update({ data: { analysisId: a.id } }),
    onSuccess: (r: any) => {
      const parts = [`Updated ${r.updated} result${r.updated === 1 ? "" : "s"}.`];
      if (r.noResultFound) parts.push(`${r.noResultFound} match${r.noResultFound === 1 ? "" : "es"} not yet finished.`);
      if (r.skipped) parts.push(`${r.skipped} skipped (no score).`);
      const msg = parts.join(" ");
      if (r.updated === 0) toast.warning(msg || "No completed matches found yet for these predictions.");
      else toast.success(msg);
      qc.invalidateQueries({ queryKey: ["preds"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Update failed"),
  });
  const allPreds = (q.data?.predictions ?? []) as Prediction[];
  const preds = typeFilter === "all" ? allPreds : allPreds.filter((p) => p.prediction_type === typeFilter);
  return (
    <div className="glass rounded-xl">
      <button onClick={onToggle} className="w-full flex items-center gap-3 p-4 text-left">
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <div className="flex-1 min-w-0">
          <div className="font-semibold">{formatScanLabel(a.created_at)}</div>
          <div className="text-xs text-muted-foreground">{a.predictions_generated} pick{a.predictions_generated === 1 ? "" : "s"} · {a.matches_analyzed} match{a.matches_analyzed === 1 ? "" : "es"} analysed</div>
        </div>
        <div className="text-right">
          {a.avg_confidence != null && <div className="font-mono text-neon font-bold">{a.avg_confidence}%</div>}
        </div>
      </button>
      {open && (
        <div className="border-t border-border p-4 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{preds.length} picks shown</span>
            <Button size="sm" variant="outline" onClick={() => m.mutate()} disabled={m.isPending}>
              {m.isPending ? <Loader2 className="animate-spin h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Update Results
            </Button>
          </div>
          {q.isLoading ? <p className="text-sm text-muted-foreground">Loading picks…</p> :
           preds.length === 0 ? <p className="text-sm text-muted-foreground">No picks for this filter.</p> :
           <div className="grid md:grid-cols-2 gap-4">{preds.map((p) => <PredictionCard key={p.id} p={p} />)}</div>}
        </div>
      )}
    </div>
  );
}
