import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getPredictions } from "@/lib/predictions.functions";
import { PredictionCard, type Prediction } from "@/components/PredictionCard";
import { RunAnalysisBar } from "@/components/RunAnalysisBar";
import { useState } from "react";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "match_winner", label: "Match Winner" },
  { id: "double_chance", label: "Double Chance" },
  { id: "asian_handicap", label: "Asian Handicap" },
  { id: "over_1_5_goals", label: "Over 1.5 Goals" },
];

export const Route = createFileRoute("/matches")({
  head: () => ({
    meta: [
      { title: "Match Outcome Predictions · BetEdge AI" },
      { name: "description", content: "Match winner, double chance, Asian handicap and Over 1.5 goals predictions from live football analysis." },
    ],
  }),
  component: MatchesPage,
});

function MatchesPage() {
  const [filter, setFilter] = useState("all");
  const fn = useServerFn(getPredictions);
  const q = useQuery({ queryKey: ["preds", "match"], queryFn: () => fn({ data: { engine: "match" } }) });
  const list = ((q.data?.predictions ?? []) as Prediction[]).filter((p) => filter === "all" || p.prediction_type === filter);
  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 py-10">
      <h1 className="text-3xl font-bold">Match Outcome <span className="text-gold">Engine</span></h1>
      <p className="text-sm text-muted-foreground mt-1">Form, xG, momentum, and league-strength weighted predictions.</p>
      <div className="mt-6"><RunAnalysisBar /></div>
      <div className="mt-6 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className={`px-3 h-8 rounded-md text-xs border ${filter === f.id ? "bg-gold/15 border-gold/40 text-gold" : "border-border text-muted-foreground hover:text-foreground"}`}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="mt-6">
        {q.isLoading ? <p className="text-muted-foreground text-sm">Loading…</p> :
         list.length === 0 ? <p className="glass rounded-xl p-10 text-center text-sm text-muted-foreground">No qualifying match picks yet.</p> :
         <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">{list.map((p) => <PredictionCard key={p.id} p={p} />)}</div>}
      </div>
    </section>
  );
}
