import { createFileRoute } from "@tanstack/react-router";
import { RunAnalysisBar } from "@/components/RunAnalysisBar";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "BetEdge AI · Football Analytics Dashboard" },
      { name: "description", content: "Run Match Winner and Over 2.5 Goals scans against real live bookmaker odds. Powered by live iSportsAPI data." },
      { property: "og:title", content: "BetEdge AI · Football Analytics Dashboard" },
      { property: "og:description", content: "Statistical model scans checked against real per-match bookmaker odds for genuine expected value." },
      { property: "og:url", content: "/" },
    ],
    links: [{ rel: "canonical", href: "/" }],
  }),
  component: Dashboard,
});

function Dashboard() {
  return (
    <div className="grid-bg">
      <section className="mx-auto max-w-7xl px-4 sm:px-6 pt-10 pb-12">
        <div className="mb-6">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
            Scan <span className="text-neon">Launcher</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Match Winner and Over 2.5 Goals, scored against real live bookmaker odds. Full results live in History.
          </p>
        </div>
        <RunAnalysisBar />
      </section>
    </div>
  );
}
