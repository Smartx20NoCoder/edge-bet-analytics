import { createFileRoute } from "@tanstack/react-router";
import { RunAnalysisBar } from "@/components/RunAnalysisBar";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Dashboard · BetEdge AI" },
      { name: "description", content: "Launch live football betting scans powered by real iSportsAPI data." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  return (
    <div className="grid-bg">
      <section className="mx-auto max-w-5xl px-4 sm:px-6 pt-10 pb-10">
        <div className="mb-6">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
            Scan <span className="text-neon">Launcher</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configure a scan and run it. Picks land in Matches, Corners, and History.
          </p>
        </div>
        <RunAnalysisBar />
      </section>
    </div>
  );
}
