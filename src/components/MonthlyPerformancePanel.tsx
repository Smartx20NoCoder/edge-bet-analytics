import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getMonthlyPickPerformance } from "@/lib/monthly-performance.functions";
import { ChevronDown, ChevronRight, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function formatMonth(key: string) {
  const [y, m] = key.split("-");
  return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
}

function Row({ label, win, loss, pending, winRate }: { label: string; win: number; loss: number; pending: number; winRate: number | null }) {
  return (
    <div className="flex items-center justify-between text-xs py-1">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2 font-mono">
        <span className="text-neon">{win}W</span>
        <span className="text-destructive">{loss}L</span>
        {pending > 0 && <span className="text-muted-foreground">{pending}P</span>}
        {winRate != null && (
          <span className={cn("ml-1 px-1.5 rounded", winRate >= 50 ? "text-neon" : "text-destructive")}>
            {winRate}%
          </span>
        )}
      </div>
    </div>
  );
}

export function MonthlyPerformancePanel() {
  const fn = useServerFn(getMonthlyPickPerformance);
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["monthly-pick-performance"],
    queryFn: () => fn({ data: { months: 6 } }),
    enabled: open,
  });

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 pb-8">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <BarChart3 className="h-3.5 w-3.5" />
        Monthly win/loss (Single & Combo of the Day)
      </button>
      {open && (
        <div className="mt-2 glass rounded-xl p-4 max-w-md">
          {q.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : !q.data?.months?.length ? (
            <p className="text-xs text-muted-foreground">No graded picks yet.</p>
          ) : (
            <div className="space-y-3">
              {q.data.months.map((m: any) => (
                <div key={m.month} className="pb-2 border-b border-border/40 last:border-0 last:pb-0">
                  <div className="text-[11px] font-semibold mb-1">{formatMonth(m.month)}</div>
                  <Row label="Single" win={m.singleWin} loss={m.singleLoss} pending={m.singlePending} winRate={m.singleWinRate} />
                  <Row label="Combo" win={m.comboWin} loss={m.comboLoss} pending={m.comboPending} winRate={m.comboWinRate} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
