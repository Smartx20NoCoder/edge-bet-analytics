import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { AlertTriangle, CheckCircle2, Clock, ShieldAlert, ShieldCheck, TrendingUp, XCircle } from "lucide-react";

export type Prediction = {
  id: string;
  engine: string;
  prediction_type: string;
  selection: string;
  home_team: string;
  away_team: string;
  league_name: string | null;
  kickoff: string | null;
  confidence: number | string;
  projected_corners: number | string | null;
  risk_level: string;
  reasons: string[] | any;
  recommendation: string | null;
  home_score?: number | null;
  away_score?: number | null;
  total_corners?: number | null;
  ft_status?: string | null;
  is_correct?: boolean | null;
};

function confColor(c: number) {
  if (c >= 85) return "text-neon";
  if (c >= 75) return "text-gold";
  return "text-destructive";
}
function confBar(c: number) {
  if (c >= 85) return "bg-neon";
  if (c >= 75) return "bg-gold";
  return "bg-destructive";
}

const TYPE_LABEL: Record<string, string> = {
  over_6_5_corners: "Over 6.5 Corners",
  over_7_5_corners: "Over 7.5 Corners",
  match_winner: "Match Winner",
  double_chance: "Double Chance",
  asian_handicap: "Asian Handicap",
  over_1_5_goals: "Over 1.5 Goals",
};

export function PredictionCard({ p }: { p: Prediction }) {
  const conf = Number(p.confidence);
  const reasons: string[] = Array.isArray(p.reasons) ? p.reasons : [];
  const ko = p.kickoff ? new Date(p.kickoff) : null;
  const impliedOdds = (100 / conf).toFixed(2);
  const hasResult = p.home_score != null && p.away_score != null;
  return (
    <div className="glass rounded-xl p-5 flex flex-col gap-4 hover:translate-y-[-2px] transition-transform">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{p.league_name ?? "League"}</div>
          <div className="font-semibold text-base truncate">
            {p.home_team} <span className="text-muted-foreground">vs</span> {p.away_team}
          </div>
          {ko && (
            <div className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              {ko.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
            </div>
          )}
        </div>
        <Badge variant="outline" className="border-border bg-accent/40 text-[10px] uppercase tracking-wider">
          {TYPE_LABEL[p.prediction_type] ?? p.prediction_type}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Selection</div>
          <div className="text-lg font-bold">{p.selection}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Implied odds <span className="text-foreground font-semibold font-mono">{impliedOdds}</span>
            {p.projected_corners != null && (
              <> · Proj corners <span className="text-foreground font-semibold">{Number(p.projected_corners).toFixed(2)}</span></>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">Confidence</div>
          <div className={cn("font-mono text-3xl font-bold", confColor(conf))}>{conf.toFixed(1)}<span className="text-base">%</span></div>
        </div>
      </div>

      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
        <div className={cn("h-full transition-all", confBar(conf))} style={{ width: `${Math.min(100, conf)}%` }} />
      </div>

      {reasons.length > 0 && (
        <ul className="space-y-1.5">
          {reasons.slice(0, 4).map((r, i) => (
            <li key={i} className="text-xs text-muted-foreground flex gap-2">
              <TrendingUp className="h-3 w-3 mt-0.5 text-neon shrink-0" />
              <span>{r}</span>
            </li>
          ))}
        </ul>
      )}

      {hasResult && (
        <div className={cn(
          "rounded-md border px-3 py-2 flex items-center justify-between text-xs",
          p.is_correct === true ? "border-neon/40 bg-neon/5 text-neon" :
          p.is_correct === false ? "border-destructive/40 bg-destructive/5 text-destructive" :
          "border-border bg-secondary/40 text-muted-foreground",
        )}>
          <span className="inline-flex items-center gap-1.5 font-semibold">
            {p.is_correct === true ? <CheckCircle2 className="h-3.5 w-3.5" /> :
             p.is_correct === false ? <XCircle className="h-3.5 w-3.5" /> : null}
            FT {p.home_score}–{p.away_score}
            {p.total_corners != null && <span className="ml-2 text-muted-foreground">· {p.total_corners} corners</span>}
          </span>
          <span className="uppercase tracking-wider text-[10px]">
            {p.is_correct === true ? "WON" : p.is_correct === false ? "LOST" : "PENDING"}
          </span>
        </div>
      )}

      <div className="flex items-center justify-between pt-2 border-t border-border/60">
        <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium",
          p.risk_level === "low" ? "text-neon" : p.risk_level === "medium" ? "text-gold" : "text-destructive")}>
          {p.risk_level === "low" ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
          {p.risk_level.toUpperCase()} RISK
        </span>
        {p.recommendation && (
          <span className="text-[11px] text-muted-foreground italic truncate ml-3">{p.recommendation}</span>
        )}
      </div>
    </div>
  );
}
