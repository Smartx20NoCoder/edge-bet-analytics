import { Link } from "@tanstack/react-router";
import { useAdminAccess } from "@/lib/admin-session";
import { createFileRoute } from "@tanstack/react-router";
import { RunAnalysisBar } from "@/components/RunAnalysisBar";
import { DailyPicksPanel } from "@/components/DailyPicksPanel";
import { MonthlyPerformancePanel } from "@/components/MonthlyPerformancePanel";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "BetEdge AI · Football Analytics Dashboard" },
      { name: "description", content: "Run Match Winner and Over 2.5 Goals scans against real live bookmaker odds. Powered by Goaloo and The Odds API data." },
      { property: "og:title", content: "BetEdge AI · Football Analytics Dashboard" },
      { property: "og:description", content: "Statistical model scans checked against real per-match bookmaker odds for genuine expected value." },
      { property: "og:url", content: "/" },
    ],
    links: [{ rel: "canonical", href: "/" }],
  }),
  component: Dashboard,
});

function Dashboard() {
  const isAdmin = useAdminAccess();
  return (
    <div className="grid-bg min-w-0 overflow-x-hidden">
      <section className="mx-auto w-full max-w-6xl px-3 sm:px-4 lg:px-6 pt-7 sm:pt-10 pb-8 sm:pb-12">
        <div className="mb-5 sm:mb-6">
          <h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold tracking-tight">
            {isAdmin ? "Scan Launcher" : "Football Analytics"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl leading-5">
            Match Winner and Over 2.5 Goals, scored against real live bookmaker odds. Full results live in History.
          </p>
        </div>
        {isAdmin ? <RunAnalysisBar /> : <Link to="/history" className="text-neon underline">View saved predictions and results</Link>}
      </section>
      {isAdmin && <><MonthlyPerformancePanel /><DailyPicksPanel /></>}
    </div>
  );
}
