import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { runAnalysis } from "@/lib/predictions.functions";
import { Loader2, RefreshCw, Calendar, Clock, Hash, TrendingUp } from "lucide-react";
import { toast } from "sonner";

const TIMEFRAMES = [
  { hours: 4, label: "Next 4h" },
  { hours: 6, label: "Next 6h" },
  { hours: 12, label: "Next 12h" },
  { hours: 24, label: "Next 24h" },
];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function RunAnalysisBar() {
  const [date, setDate] = useState(todayISO());
  const [timeframeHours, setTimeframeHours] = useState(6);
  const [maxMatches, setMaxMatches] = useState(15);
  const [minOdds, setMinOdds] = useState(1.15);
  const [trustedOnly, setTrustedOnly] = useState(true);
  const [refresh, setRefresh] = useState(false);

  const run = useServerFn(runAnalysis);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => run({ data: { date, timeframeHours, maxMatches, minOdds, trustedOnly, refresh } }),
    onSuccess: (r) => {
      toast.success(`Scan complete — ${r.predictionsGenerated} picks from ${r.matchesAnalyzed} matches`);
      qc.invalidateQueries();
    },
    onError: (e: any) => toast.error(e?.message ?? "Scan failed"),
  });

  return (
    <div className="glass rounded-xl p-4 space-y-4">
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Field label="Date" Icon={Calendar}>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-9 w-full rounded-md bg-secondary border border-border px-3 text-sm font-mono"
          />
        </Field>
        <Field label="Timeframe" Icon={Clock}>
          <div className="flex flex-wrap gap-1">
            {TIMEFRAMES.map((t) => (
              <button
                key={t.hours}
                onClick={() => setTimeframeHours(t.hours)}
                className={`px-2.5 h-9 rounded-md text-xs border ${timeframeHours === t.hours ? "bg-neon/10 border-neon/40 text-neon" : "border-border text-muted-foreground hover:text-foreground"}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Max Matches" Icon={Hash}>
          <input
            type="number"
            min={1}
            max={40}
            value={maxMatches}
            onChange={(e) => setMaxMatches(Math.max(1, Math.min(40, Number(e.target.value) || 1)))}
            className="h-9 w-full rounded-md bg-secondary border border-border px-3 text-sm font-mono"
          />
        </Field>
        <Field label="Min Implied Odds" Icon={TrendingUp}>
          <input
            type="number"
            step="0.05"
            min={1}
            max={5}
            value={minOdds}
            onChange={(e) => setMinOdds(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
            className="h-9 w-full rounded-md bg-secondary border border-border px-3 text-sm font-mono"
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={trustedOnly} onChange={(e) => setTrustedOnly(e.target.checked)} className="accent-neon" />
          Major leagues only
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={refresh} onChange={(e) => setRefresh(e.target.checked)} className="accent-neon" />
          Force re-fetch analysis (uses extra API calls)
        </label>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-widest text-muted-foreground">200 calls/day · manual only</span>
          <Button onClick={() => m.mutate()} disabled={m.isPending} className="bg-neon text-neon-foreground hover:bg-neon/90">
            {m.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {m.isPending ? "Scanning…" : "Run Analysis"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, Icon, children }: { label: string; Icon: any; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
        <Icon className="h-3 w-3" /> {label}
      </div>
      {children}
    </div>
  );
}
