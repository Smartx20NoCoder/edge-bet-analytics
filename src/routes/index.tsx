import { createFileRoute } from "@tanstack/react-router";
import { RunAnalysisBar } from "@/components/RunAnalysisBar";
import { ScanGroupedList } from "@/components/ScanGroupedList";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "BetEdge AI · Football Analytics Dashboard" },
      { name: "description", content: "Run multi-engine football scans and surface combo-ready picks in one investable table. Powered by live iSportsAPI data." },
      { property: "og:title", content: "BetEdge AI · Football Analytics Dashboard" },
      { property: "og:description", content: "Multi-engine scans, combo highlights, professional bankroll discipline." },
      { property: "og:url", content: "/" },
    ],
    links: [{ rel: "canonical", href: "/" }],
  }),
  component: Dashboard,
});

function Dashboard() {
  return (
    <div className="grid-bg">
      <section className="mx-auto max-w-7xl px-4 sm:px-6 pt-10 pb-6">
        <div className="mb-6">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
            Scan <span className="text-neon">Launcher</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every match scored across Match Winner, Over 1.5, Double Chance and Corners. Combo rows compound your edge — bet where engines agree.
          </p>
        </div>
        <RunAnalysisBar />
      </section>
      <section className="mx-auto max-w-7xl px-4 sm:px-6 pb-12">
        <div className="mb-3">
          <h2 className="text-xl font-semibold tracking-tight">Recent <span className="text-gold">Scans</span></h2>
          <p className="text-xs text-muted-foreground">Open a scan to see one row per match — combos highlighted for compounding plays.</p>
        </div>
        <ScanGroupedList engine="match" typeFilter="all" accent="neon" view="table" />
      </section>
    </div>
  );
}
