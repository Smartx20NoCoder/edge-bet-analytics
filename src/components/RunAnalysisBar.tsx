import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { runAnalysis } from "@/lib/predictions.functions";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

const PRESETS = [
  { id: "1639", label: "Default League" },
  { id: "37", label: "Premier League" },
  { id: "31", label: "La Liga" },
  { id: "8", label: "Serie A" },
  { id: "53", label: "Bundesliga" },
  { id: "16", label: "Ligue 1" },
];

export function RunAnalysisBar({ defaultLeagueId = "1639" }: { defaultLeagueId?: string }) {
  const [leagueId, setLeagueId] = useState(defaultLeagueId);
  const run = useServerFn(runAnalysis);
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => run({ data: { leagueId } }),
    onSuccess: (r) => {
      toast.success(`Scan complete — ${r.predictionsGenerated} picks from ${r.matchesAnalyzed} matches`);
      qc.invalidateQueries();
    },
    onError: (e: any) => toast.error(e?.message ?? "Scan failed"),
  });
  return (
    <div className="glass rounded-xl p-4 flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider text-muted-foreground">League</span>
        <input
          value={leagueId}
          onChange={(e) => setLeagueId(e.target.value)}
          className="h-9 w-28 rounded-md bg-secondary border border-border px-3 text-sm font-mono"
          placeholder="leagueId"
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => setLeagueId(p.id)}
            className={`px-2.5 h-7 rounded-md text-xs border ${leagueId === p.id ? "bg-neon/10 border-neon/40 text-neon" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="ml-auto">
        <Button onClick={() => m.mutate()} disabled={m.isPending} className="bg-neon text-neon-foreground hover:bg-neon/90">
          {m.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {m.isPending ? "Scanning live data…" : "Run Analysis"}
        </Button>
      </div>
    </div>
  );
}
