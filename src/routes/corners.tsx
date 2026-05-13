import { createFileRoute } from "@tanstack/react-router";
import { ScanGroupedList } from "@/components/ScanGroupedList";
import { useState } from "react";

export const Route = createFileRoute("/corners")({
  head: () => ({
    meta: [
      { title: "Corner Predictions · BetEdge AI" },
      { name: "description", content: "Over 6.5 and 7.5 corner predictions from real football data with 75%+ statistical confidence scoring." },
      { property: "og:title", content: "Corner Predictions · BetEdge AI" },
      { property: "og:description", content: "Over 6.5 / 7.5 corner predictions grouped by scan with full reasoning." },
      { property: "og:url", content: "/corners" },
    ],
    links: [{ rel: "canonical", href: "/corners" }],
  }),
  component: CornersPage,
});

const FILTERS = [
  { id: "all", label: "All Lines" },
  { id: "over_6_5_corners", label: "Over 6.5" },
  { id: "over_7_5_corners", label: "Over 7.5" },
];

function CornersPage() {
  const [filter, setFilter] = useState("all");
  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 py-10">
      <h1 className="text-3xl font-bold">Corner <span className="text-neon">Engine</span></h1>
      <p className="text-sm text-muted-foreground mt-1">Over 6.5 / 7.5 corners · 75%+ confidence · grouped by scan.</p>
      <p className="text-xs text-muted-foreground mt-2 italic">Run a scan from the Dashboard to add new picks.</p>
      <div className="mt-6 flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className={`px-3 h-8 rounded-md text-xs border ${filter === f.id ? "bg-neon/15 border-neon/40 text-neon" : "border-border text-muted-foreground hover:text-foreground"}`}>
            {f.label}
          </button>
        ))}
      </div>
      <div className="mt-6">
        <ScanGroupedList engine="corners" typeFilter={filter} accent="neon" />
      </div>
    </section>
  );
}
