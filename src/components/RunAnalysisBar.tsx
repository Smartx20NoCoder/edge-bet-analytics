import { useEffect, useRef, useState } from "react";
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

// Scanner focuses on match_winner and over_2_5_goals only — the only two bet types with a
// real, measurable edge in this API's data. Double chance, Asian handicap and corners were
// removed: there's no real bookmaker price for any of them to compute EV against.
const BET_TYPES = [
  { id: "all", label: "All" },
  { id: "match_winner", label: "Match Winner" },
  { id: "over_2_5_goals", label: "Over 2.5 Goals" },
] as const;

type LogEntry = { kind: "status" | "match" | "match_done" | "match_error" | "done" | "error"; text: string; at: number };

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function RunAnalysisBar() {
  const [date, setDate] = useState(todayISO());
  const [timeframeHours, setTimeframeHours] = useState(12);
  const [maxMatches, setMaxMatches] = useState(50);
  // Recommended defaults for EV research: widen the odds range rather than narrow it —
  // very short odds can't carry meaningful EV even when "correct," very long odds are
  // where model error compounds.
  const [minOdds, setMinOdds] = useState(1.5);
  const [maxOdds, setMaxOdds] = useState(6);
  const [oddsBounds, setOddsBounds] = useState<[number, number]>([1, 10]);
  const [trustedOnly, setTrustedOnly] = useState(true);
  const [refresh, setRefresh] = useState(false);
  const [betType, setBetType] = useState<string>("all");
  // Threshold values + adjustable slider bounds for each.
  const [winRateFloor, setWinRateFloor] = useState(45);
  const [winRateBounds, setWinRateBounds] = useState<[number, number]>([35, 70]);
  const [drawRateCeil, setDrawRateCeil] = useState(35);
  const [drawRateBounds, setDrawRateBounds] = useState<[number, number]>([15, 50]);
  // Lowered from 52% — this floor filters on confidence (likelihood), not EV (price value).
  // Raising it just surfaces more "likely" favourites, which are often priced too short to
  // carry real value. Lowering it lets more candidates through so the EV badge — the real
  // filter — has more to work with.
  const [matchWinnerFloor, setMatchWinnerFloor] = useState(49);
  const [matchWinnerBounds, setMatchWinnerBounds] = useState<[number, number]>([45, 75]);
  const [over25Floor, setOver25Floor] = useState(55);
  const [over25Bounds, setOver25Bounds] = useState<[number, number]>([40, 90]);
  const [apiKey, setApiKey] = useState<1 | 2>(() => {
    if (typeof window === "undefined") return 1;
    const v = window.localStorage.getItem("betedge.apiKey");
    return v === "2" ? 2 : 1;
  });
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("betedge.apiKey", String(apiKey));
  }, [apiKey]);

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

  const failoverNotifiedRef = useRef<string | null>(null);
  useEffect(() => {
    const f = usage.data?.failoverAt;
    if (f && failoverNotifiedRef.current !== f) {
      failoverNotifiedRef.current = f;
      toast.warning("API Key 1 exhausted — switched to Key 2", {
        description: "Counter has been reset to track usage on the new key.",
        duration: 8000,
      });
    }
  }, [usage.data?.failoverAt]);

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
      minOdds: String(minOdds), maxOdds: String(maxOdds),
      trustedOnly: String(trustedOnly), refresh: String(refresh),
      betType, apiKey: String(apiKey),
      winRateFloor: String(winRateFloor / 100),
      drawRateCeil: String(drawRateCeil / 100),
      over25Floor: String(over25Floor),
      matchWinnerFloor: String(matchWinnerFloor),
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
      <div>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground mb-2">
          <Target className="h-3 w-3" /> Bet Type
        </div>
        <div className="flex flex-wrap gap-1.5">
          {BET_TYPES.map((b) => (
            <button
              key={b.id}
              onClick={() => setBetType(b.id)}
              className={`px-3 h-8 rounded-md text-xs border transition-colors ${betType === b.id ? "bg-neon/15 border-neon/50 text-neon" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Field label="Date" Icon={Calendar} htmlFor="scan-date">
          <input
            id="scan-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-9 w-full rounded-md bg-secondary border border-border px-3 text-sm font-mono"
          />
        </Field>
        <Field label="Timeframe" Icon={Clock}>
          <div role="group" aria-label="Timeframe" className="flex flex-wrap gap-1">
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
        <Field label="Max Matches" Icon={Hash} htmlFor="scan-max-matches">
          <input
            id="scan-max-matches"
            type="number"
            min={1}
            max={80}
            value={maxMatches}
            onChange={(e) => setMaxMatches(Math.max(1, Math.min(80, Number(e.target.value) || 1)))}
            className="h-9 w-full rounded-md bg-secondary border border-border px-3 text-sm font-mono"
          />
        </Field>
        <Field label={`Odds Range: ${minOdds.toFixed(2)} – ${maxOdds.toFixed(2)}`} Icon={TrendingUp}>
          <RangeWithBounds
            value={[minOdds, maxOdds]}
            bounds={oddsBounds}
            step={0.05}
            min={1}
            max={20}
            decimals={2}
            onValueChange={([lo, hi]) => {
              setMinOdds(Math.min(lo, hi));
              setMaxOdds(Math.max(lo, hi));
            }}
            onBoundsChange={(b) => {
              setOddsBounds(b);
              setMinOdds((v) => Math.min(Math.max(v, b[0]), b[1]));
              setMaxOdds((v) => Math.min(Math.max(v, b[0]), b[1]));
            }}
          />
        </Field>
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <ThresholdField label={`Match Winner Floor: ${matchWinnerFloor}%`}
          value={matchWinnerFloor} bounds={matchWinnerBounds}
          onValueChange={setMatchWinnerFloor} onBoundsChange={setMatchWinnerBounds} />
        <ThresholdField label={`Over 2.5 Floor: ${over25Floor}%`}
          value={over25Floor} bounds={over25Bounds}
          onValueChange={setOver25Floor} onBoundsChange={setOver25Bounds} />
        <ThresholdField label={`Team Win Rate Floor: ${winRateFloor}%`}
          value={winRateFloor} bounds={winRateBounds}
          onValueChange={setWinRateFloor} onBoundsChange={setWinRateBounds} />
        <ThresholdField label={`Team Draw Rate Ceiling: ${drawRateCeil}%`}
          value={drawRateCeil} bounds={drawRateBounds}
          onValueChange={setDrawRateCeil} onBoundsChange={setDrawRateBounds} />
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
          <div className="inline-flex items-center rounded-md border border-border overflow-hidden" role="group" aria-label="API Key selector">
            {[1, 2].map((k) => (
              <button
                key={k}
                onClick={() => setApiKey(k as 1 | 2)}
                className={`px-2.5 h-7 text-[11px] font-mono transition-colors ${apiKey === k ? "bg-neon/15 text-neon" : "text-muted-foreground hover:text-foreground"}`}
                title={`Force this scan to use API Key ${k} only`}
              >
                API {k}
              </button>
            ))}
          </div>
          <span className={`inline-flex items-center gap-1.5 px-2 h-7 rounded-md border text-[11px] font-mono ${
            (usage.data?.count ?? 0) >= (usage.data?.limit ?? 200) * 0.9
              ? "border-destructive/40 text-destructive bg-destructive/10"
              : "border-neon/30 text-neon bg-neon/5"
          }`} title="iSports API calls today">
            <Radio className="h-3 w-3" />
            {usage.data?.count ?? "—"}/{usage.data?.limit ?? 200} (Key {usage.data?.activeKey ?? 1})
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

function Field({ label, Icon, children, htmlFor }: { label: string; Icon: any; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
        <Icon className="h-3 w-3" /> {label}
      </label>
      {children}
    </div>
  );
}

// Single-value threshold slider with editable lower/upper bound inputs.
function ThresholdField({
  label, value, bounds, onValueChange, onBoundsChange, step = 1,
}: {
  label: string;
  value: number;
  bounds: [number, number];
  onValueChange: (v: number) => void;
  onBoundsChange: (b: [number, number]) => void;
  step?: number;
}) {
  const [lo, hi] = bounds;
  const clamped = Math.min(Math.max(value, lo), hi);
  return (
    <div>
      <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
        <Target className="h-3 w-3" /> {label}
      </label>
      <Slider min={lo} max={hi} step={step} value={[clamped]}
        onValueChange={(v) => onValueChange(v[0] ?? clamped)} className="mt-2" />
      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="uppercase tracking-wider">Range</span>
        <input
          type="number" value={lo} step={step} min={0} max={hi - step}
          onChange={(e) => {
            const next = Math.min(Number(e.target.value) || 0, hi - step);
            onBoundsChange([next, hi]);
            if (value < next) onValueChange(next);
          }}
          className="h-7 w-16 rounded-md bg-secondary border border-border px-2 text-xs font-mono text-foreground"
          aria-label="Slider lower bound"
        />
        <span>–</span>
        <input
          type="number" value={hi} step={step} min={lo + step} max={100}
          onChange={(e) => {
            const next = Math.max(Number(e.target.value) || 0, lo + step);
            onBoundsChange([lo, next]);
            if (value > next) onValueChange(next);
          }}
          className="h-7 w-16 rounded-md bg-secondary border border-border px-2 text-xs font-mono text-foreground"
          aria-label="Slider upper bound"
        />
      </div>
    </div>
  );
}

// Dual-thumb range slider (e.g. odds) with editable lower/upper bound inputs.
function RangeWithBounds({
  value, bounds, onValueChange, onBoundsChange, step = 1, min = 0, max = 100, decimals = 0,
}: {
  value: [number, number];
  bounds: [number, number];
  onValueChange: (v: [number, number]) => void;
  onBoundsChange: (b: [number, number]) => void;
  step?: number;
  min?: number;
  max?: number;
  decimals?: number;
}) {
  const [blo, bhi] = bounds;
  const [vlo, vhi] = value;
  const cLo = Math.min(Math.max(vlo, blo), bhi);
  const cHi = Math.min(Math.max(vhi, blo), bhi);
  const fmt = (n: number) => n.toFixed(decimals);
  return (
    <div>
      <Slider
        min={blo} max={bhi} step={step}
        value={[cLo, cHi]}
        onValueChange={(v) => {
          const [lo, hi] = v;
          onValueChange([Math.min(lo, hi), Math.max(lo, hi)]);
        }}
        aria-label="Range slider"
        className="mt-2"
      />
      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="uppercase tracking-wider">Range</span>
        <input
          type="number" value={fmt(blo)} step={step} min={min} max={bhi - step}
          onChange={(e) => {
            const next = Math.min(Number(e.target.value) || min, bhi - step);
            onBoundsChange([next, bhi]);
          }}
          className="h-7 w-16 rounded-md bg-secondary border border-border px-2 text-xs font-mono text-foreground"
          aria-label="Slider lower bound"
        />
        <span>–</span>
        <input
          type="number" value={fmt(bhi)} step={step} min={blo + step} max={max}
          onChange={(e) => {
            const next = Math.max(Number(e.target.value) || max, blo + step);
            onBoundsChange([blo, next]);
          }}
          className="h-7 w-16 rounded-md bg-secondary border border-border px-2 text-xs font-mono text-foreground"
          aria-label="Slider upper bound"
        />
      </div>
    </div>
  );
}
