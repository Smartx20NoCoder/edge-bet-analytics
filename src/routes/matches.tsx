import { createFileRoute } from "@tanstack/react-router";
import { ScanGroupedList } from "@/components/ScanGroupedList";
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
  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 py-10">
      <h1 className="text-3xl font-bold">Match Outcome <span className="text-gold">Engine</span></h1>
      <p className="text-sm text-muted-foreground mt-1">Form, xG, momentum, and league-strength weighted predictions · grouped by scan.</p>
      <p className="text-xs text-muted-foreground mt-2 italic">Run a scan from the Dashboard to add new picks.</p>
      <div className="mt-6 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className={`px-3 h-8 rounded-md text-xs border ${filter === f.id ? "bg-gold/15 border-gold/40 text-gold" : "border-border text-muted-foreground hover:text-foreground"}`}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="mt-6">
        <ScanGroupedList engine="match" typeFilter={filter} accent="gold" />
      </div>
    </section>
  );
}
