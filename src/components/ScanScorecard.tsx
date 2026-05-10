import { CheckCircle2, Hourglass, XCircle } from "lucide-react";

export function ScanScorecard({
  total,
  won,
  pending,
}: {
  total: number;
  won: number;
  pending: number;
}) {
  if (!total) return null;
  if (pending > 0) {
    return (
      <span className="inline-flex items-center gap-1 px-2 h-6 rounded-md text-xs font-mono font-semibold border border-amber-500/40 bg-amber-500/10 text-amber-300">
        <Hourglass className="h-3 w-3" />
        {won}/{total}
      </span>
    );
  }
  if (won === total) {
    return (
      <span className="inline-flex items-center gap-1 px-2 h-6 rounded-md text-xs font-mono font-semibold border border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
        <CheckCircle2 className="h-3 w-3" />
        WON {total}/{total}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 h-6 rounded-md text-xs font-mono font-semibold border border-rose-500/40 bg-rose-500/10 text-rose-300">
      <XCircle className="h-3 w-3" />
      {won}/{total}
    </span>
  );
}
