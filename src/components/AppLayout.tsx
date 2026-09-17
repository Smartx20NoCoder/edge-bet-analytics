import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { Activity, History, LayoutDashboard, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/ThemeToggle";

const NAV = [
  { to: "/", label: "Dashboard", Icon: LayoutDashboard },
  { to: "/history", label: "History", Icon: History },
  { to: "/settings", label: "Settings", Icon: Settings },
] as const;

export function AppLayout() {
  const loc = useLocation();
  return (
    <div className="min-h-screen min-w-0 flex flex-col overflow-x-hidden">
      <header className="sticky top-0 z-30 glass border-b">
        <div className="mx-auto w-full max-w-6xl px-3 sm:px-4 lg:px-6 min-h-16 py-2 flex items-center justify-between gap-3">
          <Link to="/" className="min-w-0 flex items-center gap-2" onClick={(e) => { e.preventDefault(); window.location.assign("/"); }}>
            <div className="h-8 w-8 shrink-0 rounded-md bg-neon glow-neon flex items-center justify-center">
              <Activity className="h-4 w-4 text-neon-foreground" />
            </div>
            <div className="min-w-0 leading-tight">
              <div className="font-bold tracking-tight text-base">BetEdge<span className="text-neon">·</span>AI</div>
              <div className="hidden sm:block text-[10px] uppercase tracking-[0.18em] text-muted-foreground truncate">Football Analytics Terminal</div>
            </div>
          </Link>
          <div className="flex items-center gap-2 shrink-0">
            <nav className="hidden md:flex items-center gap-1">
              {NAV.map(({ to, label, Icon }) => {
                const active = loc.pathname === to;
                return (
                  <Link
                    key={to}
                    to={to}
                    onClick={(e) => { e.preventDefault(); window.location.assign(to); }}
                    className={cn(
                      "inline-flex items-center gap-2 px-3 h-9 rounded-md text-sm transition-colors",
                      active
                        ? "bg-neon/10 text-neon glow-neon"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </Link>
                );
              })}
            </nav>
            <ThemeToggle />
          </div>
        </div>
        <nav className="md:hidden flex overflow-x-auto px-3 pb-2 gap-1">
          {NAV.map(({ to, label, Icon }) => {
            const active = loc.pathname === to;
            return (
              <Link
                key={to}
                to={to}
                onClick={(e) => { e.preventDefault(); window.location.assign(to); }}
                className={cn(
                  "shrink-0 inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-xs",
                  active ? "bg-neon/10 text-neon" : "text-muted-foreground bg-accent/40",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="flex-1 min-w-0">
        <Outlet />
      </main>
      <footer className="border-t py-6 px-3 text-center text-xs text-muted-foreground">
        Powered by real iSportsAPI data · For informational use only · Bet responsibly.
      </footer>
    </div>
  );
}
