import { useMemo } from "react";
import { Clock, Flame, TrendingUp, CheckCircle2, XCircle, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Prediction } from "./PredictionCard";

/**
 * One row per match. Cells = confidence % per bet type, or "—" if not qualifying.
 * Rows with 2+ qualifying bet types are highlighted as combo candidates.
 */

type Col = { key: string; label: string; types: string[] };

const COLUMNS: Col[] = [
  { key: "match_winner", label: "Match Winner", types: ["match_winner"] },
  { key: "over_1_5_goals", label: "Over 1.5", types: ["over_1_5_goals"] },
  { key: "double_chance", label: "Double Chance", types: ["double_chance"] },
  { key: "over_7_5_corners", label: "Over 7.5 Corners", types: ["over_7_5_corners", "over_6_5_corners"] },
  { key: "over_8_5_corners", label: "Over 8.5 Corners", types: ["over_8_5_corners"] },
];

type MatchRow = {
  match_id: string;
  home_team: string;
  away_team: string;
  league_name: string | null;
  kickoff: string | null;
  oddsAvailable: boolean;
  hasResult: boolean;
  cells: Record<string, Prediction | null>;
  qualifyingCount: number;
  topConfidence: number;
};

function confTone(c: number | null | undefined) {
  if (c == null) return "text-muted-foreground";
  if (c >= 80) return "text-neon";
  if (c >= 70) return "text-gold";
  if (c >= 60) return "text-foreground";
  return "text-muted-foreground";
}

export function ScanTable({ predictions }: { predictions: Prediction[] }) {
  const rows = useMemo<MatchRow[]>(() => {
    const map = new Map<string, MatchRow>();
    for (const p of predictions) {
      const id = String(p.match_id ?? `${p.home_team}-${p.away_team}-${p.kickoff}`);
      let row = map.get(id);
      if (!row) {
        row = {
          match_id: id,
          home_team: p.home_team,
          away_team: p.away_team,
          league_name: p.league_name,
          kickoff: p.kickoff,
          oddsAvailable: p.stats?.oddsAvailable !== false,
          hasResult: p.home_score != null && p.away_score != null,
          cells: {},
          qualifyingCount: 0,
          topConfidence: 0,
        };
        map.set(id, row);
      }
      // Map prediction to its column.
      const col = COLUMNS.find((c) => c.types.includes(p.prediction_type));
      if (!col) continue;
      const conf = Number(p.confidence);
      const existing = row.cells[col.key];
      // Keep highest-confidence pick per cell (e.g. choose stronger of 6.5/7.5 corners).
      if (!existing || Number(existing.confidence) < conf) {
        row.cells[col.key] = p;
      }
    }
    // Compute qualifying counts + top confidence + sort.
    for (const row of map.values()) {
      let n = 0, top = 0;
      for (const c of COLUMNS) {
        const cell = row.cells[c.key];
        if (cell) { n++; top = Math.max(top, Number(cell.confidence)); }
      }
      row.qualifyingCount = n;
      row.topConfidence = top;
    }
    return Array.from(map.values())
      .sort((a, b) => {
        // Combos first, then by top confidence, then earliest kickoff.
        if (b.qualifyingCount !== a.qualifyingCount) return b.qualifyingCount - a.qualifyingCount;
        if (b.topConfidence !== a.topConfidence) return b.topConfidence - a.topConfidence;
        const ak = a.kickoff ? new Date(a.kickoff).getTime() : 0;
        const bk = b.kickoff ? new Date(b.kickoff).getTime() : 0;
        return ak - bk;
      });
  }, [predictions]);

  const combos = rows.filter((r) => r.qualifyingCount >= 2).length;

  if (!rows.length) {
    return <p className="text-sm text-muted-foreground">No matches qualified on any engine for this scan.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="font-mono"><span className="text-foreground font-semibold">{rows.length}</span> matches</span>
        <span className="inline-flex items-center gap-1.5">
          <Flame className="h-3.5 w-3.5 text-gold" />
          <span className="font-mono"><span className="text-gold font-semibold">{combos}</span> combo candidate{combos === 1 ? "" : "s"}</span>
        </span>
        <span className="ml-auto italic">Invest where multiple engines align — that's where compounding edge lives.</span>
      </div>

      <div className="rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/60 text-[10px] uppercase tracking-widest text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Match</th>
                {COLUMNS.map((c) => (
                  <th key={c.key} className="text-center px-3 py-2 font-medium whitespace-nowrap">{c.label}</th>
                ))}
                <th className="text-center px-3 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isCombo = r.qualifyingCount >= 2;
                const ko = r.kickoff ? new Date(r.kickoff) : null;
                return (
                  <tr
                    key={r.match_id}
                    className={cn(
                      "border-t border-border align-top transition-colors",
                      isCombo ? "bg-gold/5 hover:bg-gold/10" : "hover:bg-secondary/40",
                    )}
                  >
                    <td className="px-3 py-3 min-w-[220px]">
                      <div className="flex items-start gap-2">
                        {isCombo && (
                          <Flame className="h-3.5 w-3.5 mt-0.5 text-gold shrink-0" aria-label="Combo candidate" />
                        )}
                        <div className="min-w-0">
                          <div className="font-semibold truncate">
                            {r.home_team} <span className="text-muted-foreground">vs</span> {r.away_team}
                          </div>
                          <div className="text-[11px] text-muted-foreground truncate">{r.league_name ?? "—"}</div>
                          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
                            {ko && (
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {ko.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}
                              </span>
                            )}
                            {!r.oddsAvailable && (
                              <span className="inline-flex items-center gap-1 text-gold">
                                <AlertTriangle className="h-3 w-3" /> no 1X2 odds
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    {COLUMNS.map((c) => {
                      const cell = r.cells[c.key];
                      if (!cell) {
                        return (
                          <td key={c.key} className="px-3 py-3 text-center text-muted-foreground font-mono">—</td>
                        );
                      }
                      const conf = Number(cell.confidence);
                      const implied = (100 / conf).toFixed(2);
                      const label =
                        cell.prediction_type === "over_6_5_corners" ? "O6.5" :
                        cell.prediction_type === "over_7_5_corners" ? "O7.5" :
                        cell.selection;
                      return (
                        <td key={c.key} className="px-3 py-3 text-center" title={`${cell.selection} · implied odds ${implied}`}>
                          <div className={cn("font-mono font-bold text-base", confTone(conf))}>
                            {conf.toFixed(0)}%
                          </div>
                          <div className="text-[10px] text-muted-foreground truncate">{label}</div>
                          <div className="text-[10px] text-muted-foreground font-mono">@ {implied}</div>
                        </td>
                      );
                    })}
                    <td className="px-3 py-3 text-center whitespace-nowrap">
                      {r.hasResult ? (
                        <ResultBadge row={r} />
                      ) : (
                        <span className="text-[11px] text-muted-foreground italic">pending</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function ResultBadge({ row }: { row: MatchRow }) {
  // Result aggregation across cells: count won/lost from any graded prediction on this match.
  let won = 0, lost = 0;
  let homeScore: number | null = null;
  let awayScore: number | null = null;
  for (const c of COLUMNS) {
    const p = row.cells[c.key];
    if (!p) continue;
    if (homeScore == null) homeScore = p.home_score ?? null;
    if (awayScore == null) awayScore = p.away_score ?? null;
    if (p.is_correct === true) won++;
    else if (p.is_correct === false) lost++;
  }
  return (
    <div className="space-y-0.5">
      <div className="text-xs font-mono font-semibold text-foreground">
        {homeScore ?? "?"}–{awayScore ?? "?"}
      </div>
      <div className="flex items-center justify-center gap-1.5 text-[11px] font-mono">
        {won > 0 && (
          <span className="inline-flex items-center gap-0.5 text-neon">
            <CheckCircle2 className="h-3 w-3" />{won}
          </span>
        )}
        {lost > 0 && (
          <span className="inline-flex items-center gap-0.5 text-destructive">
            <XCircle className="h-3 w-3" />{lost}
          </span>
        )}
        {won === 0 && lost === 0 && <TrendingUp className="h-3 w-3 text-muted-foreground" />}
      </div>
    </div>
  );
}
