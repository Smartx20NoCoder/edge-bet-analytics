import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getDailyPicks } from "@/lib/predictions.functions";
import { CheckCircle2, XCircle, Clock, AlertTriangle, ChevronLeft, ChevronRight, Star, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const TYPE_LABEL: Record<string, string> = {
  match_winner: "Match Winner",
  match_winner_hedged: "Hedged +0.5",
  over_2_5_goals: "Over 2.5",
};

function PickRow({ p, compact }: { p: any; compact?: boolean }) {
  const ev = p.expected_value != null ? Number(p.expected_value) : null;
  const graded = p.is_correct !== null && p.is_correct !== undefined;
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-sm font-medium truncate">{p.home_team} <span className="text-muted-foreground">vs</span> {p.away_team}</div>
        <div className="text-[11px] text-muted-foreground">
          {TYPE_LABEL[p.prediction_type] ?? p.prediction_type} · {p.selection} · {Number(p.confidence).toFixed(1)}%
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className={cn("font-mono text-sm font-semibold", ev != null && ev >= 0 ? "text-neon" : "text-destructive")}>
          {ev != null ? `${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}%` : "—"} @ {Number(p.market_odds).toFixed(2)}
        </div>
        {graded && (
          <div className={cn("text-[11px] inline-flex items-center gap-1", p.is_correct ? "text-neon" : "text-destructive")}>
            {p.is_correct ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
            {p.is_correct ? "Won" : "Lost"}
          </div>
        )}
        {!graded && <div className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><Clock className="h-3 w-3" /> Pending</div>}
      </div>
    </div>
  );
}

function DayCard({ d }: { d: any }) {
  const dateLabel = new Date(d.day + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return (
    <div className="glass rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{dateLabel}</span>
        <div className="text-right">
          <div className="text-[11px] text-muted-foreground">{d.qualifyingPicksCount} qualifying pick{d.qualifyingPicksCount === 1 ? "" : "s"}</div>
          {d.excludedOutliers > 0 && (
            <div className="text-[10px] text-gold" title="EV above 35% — excluded as likely unreliable, not spotlighted as best">
              {d.excludedOutliers} outlier{d.excludedOutliers === 1 ? "" : "s"} excluded (EV &gt;40%)
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-gold mb-1.5">
          <Star className="h-3 w-3" /> Single of the Day
        </div>
        {d.single ? <PickRow p={d.single} /> : <p className="text-xs text-muted-foreground">No qualifying pick this day.</p>}
      </div>

      <div className="pt-2 border-t border-border/60">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
          <Link2 className="h-3 w-3" /> Combo of the Day
          <span className="ml-1 inline-flex items-center gap-1 text-gold"><AlertTriangle className="h-3 w-3" /> Experimental</span>
        </div>
        {d.combo ? (
          <div className="space-y-1">
            {d.combo.legs.map((leg: any) => <PickRow key={leg.id} p={leg} compact />)}
            <div className="flex items-center justify-between pt-1.5 mt-1 border-t border-border/40">
              <span className="text-xs text-muted-foreground">Combined odds {d.combo.combinedOdds.toFixed(2)}</span>
              {d.combo.isCorrect === null ? (
                <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1"><Clock className="h-3 w-3" /> Pending</span>
              ) : (
                <span className={cn("text-[11px] font-semibold inline-flex items-center gap-1", d.combo.isCorrect ? "text-neon" : "text-destructive")}>
                  {d.combo.isCorrect ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                  {d.combo.isCorrect ? `Won — ${d.combo.profit >= 0 ? "+" : ""}${d.combo.profit.toFixed(2)}` : `Lost — ${d.combo.profit.toFixed(2)}`}
                </span>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Not enough qualifying picks from different matches this day.</p>
        )}
      </div>
    </div>
  );
}

export function DailyPicksPanel() {
  const fn = useServerFn(getDailyPicks);
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ["daily-picks", page], queryFn: () => fn({ data: { page, pageSize: 14 } }) });
  const days = q.data?.days ?? [];
  const totalPages = q.data?.totalPages ?? 1;

  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 pb-12">
      <div className="mb-4">
        <h2 className="text-xl font-bold">Single & Combo <span className="text-neon">of the Day</span></h2>
        <p className="text-xs text-muted-foreground mt-1">
          Single of the Day is the highest-EV qualifying pick each day. Combo of the Day (2 legs, different matches) is tracked
          separately as an experiment — not a recommendation. Both draw only from picks with a real confirmed market price.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : days.length === 0 ? (
        <div className="glass rounded-xl p-8 text-center text-sm text-muted-foreground">No qualifying picks yet — run a scan.</div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {days.map((d: any) => <DayCard key={d.day} d={d} />)}
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              <ChevronLeft className="h-4 w-4" /> Previous
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
              Next <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
