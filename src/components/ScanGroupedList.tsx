import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { getAnalyses, getPredictions } from "@/lib/predictions.functions";
import { PredictionCard, type Prediction } from "./PredictionCard";
import { ScanScorecard } from "./ScanScorecard";

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

export function ScanGroupedList({
  engine,
  typeFilter,
  accent = "neon",
}: {
  engine: "corners" | "match";
  typeFilter: string;
  accent?: "neon" | "gold";
}) {
  const fa = useServerFn(getAnalyses);
  const fp = useServerFn(getPredictions);
  const aQ = useQuery({
    queryKey: ["analyses", "engine", engine],
    queryFn: () => fa({ data: { engine } }),
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const list = aQ.data?.analyses ?? [];

  if (aQ.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (list.length === 0)
    return <div className="glass rounded-xl p-10 text-center text-sm text-muted-foreground">No qualifying picks yet.</div>;

  return (
    <div className="space-y-2">
      {list.map((a: any) => (
        <ScanItem
          key={a.id}
          a={a}
          open={openId === a.id}
          onToggle={() => setOpenId((o) => (o === a.id ? null : a.id))}
          fp={fp}
          engine={engine}
          typeFilter={typeFilter}
          accent={accent}
        />
      ))}
    </div>
  );
}

function ScanItem({ a, open, onToggle, fp, engine, typeFilter, accent }: any) {
  const q = useQuery({
    queryKey: ["preds", "analysis", a.id, engine],
    queryFn: () => fp({ data: { analysisId: a.id, engine } }),
    enabled: open,
  });
  const allPreds = (q.data?.predictions ?? []) as Prediction[];
  const preds = typeFilter === "all" ? allPreds : allPreds.filter((p) => p.prediction_type === typeFilter);
  const accentClass = accent === "gold" ? "text-gold" : "text-neon";
  return (
    <div className="glass rounded-xl">
      <button onClick={onToggle} className="w-full flex items-center gap-3 p-4 text-left">
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <div className="flex-1 min-w-0">
          <div className="font-semibold">{formatScanLabel(a.created_at)}</div>
          <div className="text-xs text-muted-foreground">
            {a.predictions_generated} pick{a.predictions_generated === 1 ? "" : "s"} · {a.matches_analyzed} match{a.matches_analyzed === 1 ? "" : "es"} analysed
          </div>
        </div>
        {a.avg_confidence != null && (
          <div className={`font-mono font-bold ${accentClass}`}>{a.avg_confidence}%</div>
        )}
      </button>
      {open && (
        <div className="border-t border-border p-4">
          {q.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading picks…</p>
          ) : preds.length === 0 ? (
            <p className="text-sm text-muted-foreground">No picks for this filter.</p>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {preds.map((p) => <PredictionCard key={p.id} p={p} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
