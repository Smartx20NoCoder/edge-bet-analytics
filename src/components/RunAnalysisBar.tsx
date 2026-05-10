import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, RefreshCw, Calendar, Clock, Hash, TrendingUp, CheckCircle2, AlertCircle, Activity, Target, Radio } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getApiUsageToday } from "@/lib/predictions.functions";

const TIMEFRAMES = [
  { hours: 4, label: "Next 4h" },
  { hours: 6, label: "Next 6h" },
  { hours: 12, label: "Next 12h" },
  { hours: 24, label: "Next 24h" },
];

type LogEntry = { kind: "status" | "match" | "match_done" | "match_error" | "done" | "error"; text: string; at: number };

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
  const [maxPicks, setMaxPicks] = useState(3);

  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [summary, setSummary] = useState<{ matches: number; picks: number } | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const qc = useQueryClient();

  const fetchUsage = useServerFn(getApiUsageToday);
  const usage = useQuery({
    queryKey: ["api-usage-today"],
    queryFn: () => fetchUsage(),
    refetchInterval: 60_000,
  });

  const append = (e: LogEntry) => {
    setLog((prev) => [...prev, e]);
    queueMicrotask(() => logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }));
  };

  const start = async () => {
    setOpen(true);
    setRunning(true);
    setLog([]);
    setProgress({ current: 0, total: 0 });
    setSummary(null);

    const params = new URLSearchParams({
      date, timeframeHours: String(timeframeHours), maxMatches: String(maxMatches),
      minOdds: String(minOdds), trustedOnly: String(trustedOnly), refresh: String(refresh),
      maxPicks: String(maxPicks),
    });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch(`/api/analyze-stream?${params}`, { signal: ctrl.signal });
      if (!res.body) throw new Error("No stream body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            handleEvent(evt);
          } catch {}
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") {
        append({ kind: "error", text: `Stream error: ${e?.message ?? e}`, at: Date.now() });
        toast.error(e?.message ?? "Scan failed");
      }
    } finally {
      setRunning(false);
      qc.invalidateQueries();
    }
  };

  const handleEvent = (evt: any) => {
    switch (evt.event) {
      case "status":
        append({ kind: "status", text: evt.message, at: Date.now() });
        if (typeof evt.total === "number") setProgress({ current: 0, total: evt.total });
        break;
      case "match":
        setProgress({ current: evt.index, total: evt.total });
        append({
          kind: "match",
          text: `Analyzing ${evt.home} vs ${evt.away} (${evt.league}) — (${evt.index}/${evt.total})`,
          at: Date.now(),
        });
        break;
      case "match_done":
        append({
          kind: "match_done",
          text: `✓ ${evt.home} vs ${evt.away} — ${evt.picks} pick${evt.picks === 1 ? "" : "s"}`,
          at: Date.now(),
        });
        break;
      case "match_error":
        append({
          kind: "match_error",
          text: `✗ ${evt.home} vs ${evt.away} — ${evt.error}`,
          at: Date.now(),
        });
        break;
      case "done":
        setSummary({ matches: evt.matchesAnalyzed, picks: evt.predictionsGenerated });
        append({
          kind: "done",
          text: `Scan complete — ${evt.predictionsGenerated} picks from ${evt.matchesAnalyzed} matches.`,
          at: Date.now(),
        });
        toast.success(`Scan complete — ${evt.predictionsGenerated} picks from ${evt.matchesAnalyzed} matches`);
        break;
      case "error":
        append({ kind: "error", text: evt.message, at: Date.now() });
        toast.error(evt.message ?? "Scan failed");
        break;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
  };

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
      <div className="flex items-center gap-3">
        <Field label={`Max Picks: ${maxPicks}`} Icon={Target}>
          <Slider
            min={2}
            max={5}
            step={1}
            value={[maxPicks]}
            onValueChange={(v) => setMaxPicks(v[0] ?? 3)}
            className="mt-2"
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
          <span className={`inline-flex items-center gap-1.5 px-2 h-7 rounded-md border text-[11px] font-mono ${
            (usage.data?.count ?? 0) >= (usage.data?.limit ?? 200) * 0.9
              ? "border-destructive/40 text-destructive bg-destructive/10"
              : "border-neon/30 text-neon bg-neon/5"
          }`} title="iSports API calls today">
            <Radio className="h-3 w-3" />
            {usage.data?.count ?? "—"}/{usage.data?.limit ?? 200}
          </span>
          <Button onClick={start} disabled={running} className="bg-neon text-neon-foreground hover:bg-neon/90">
            {running ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {running ? "Scanning…" : "Run Analysis"}
          </Button>
        </div>
      </div>

      <Dialog open={open} onOpenChange={(v) => { if (!running) setOpen(v); }}>
        <DialogContent className="max-w-2xl glass border-neon/20">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Activity className={`h-4 w-4 ${running ? "text-neon animate-pulse" : "text-muted-foreground"}`} />
              Live Scan {running ? "in progress" : summary ? "complete" : ""}
            </DialogTitle>
          </DialogHeader>

          {progress.total > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Match progress</span>
                <span className="font-mono">{progress.current} / {progress.total}</span>
              </div>
              <div className="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-neon transition-all duration-300"
                  style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}

          <div className="mt-2 max-h-80 overflow-y-auto rounded-md border border-border bg-background/60 p-3 font-mono text-xs space-y-1">
            {log.length === 0 ? (
              <div className="text-muted-foreground">Connecting…</div>
            ) : (
              log.map((e, i) => (
                <div key={i} className={`flex items-start gap-2 ${entryColor(e.kind)}`}>
                  {entryIcon(e.kind)}
                  <span className="leading-relaxed break-words">{e.text}</span>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>

          <div className="flex items-center justify-between pt-2">
            <div className="text-xs text-muted-foreground">
              {summary ? `${summary.picks} qualifying picks · ${summary.matches} matches scanned` : running ? "Streaming live updates…" : ""}
            </div>
            <div className="flex gap-2">
              {running ? (
                <Button variant="outline" size="sm" onClick={cancel}>Cancel</Button>
              ) : (
                <Button size="sm" onClick={() => setOpen(false)}>Close</Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function entryColor(k: LogEntry["kind"]) {
  switch (k) {
    case "match_done": return "text-neon";
    case "done": return "text-neon font-semibold";
    case "match_error":
    case "error": return "text-destructive";
    case "match": return "text-foreground";
    default: return "text-muted-foreground";
  }
}
function entryIcon(k: LogEntry["kind"]) {
  if (k === "match_done" || k === "done") return <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />;
  if (k === "match_error" || k === "error") return <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />;
  if (k === "match") return <Loader2 className="h-3.5 w-3.5 mt-0.5 shrink-0 animate-spin" />;
  return <Activity className="h-3.5 w-3.5 mt-0.5 shrink-0" />;
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
