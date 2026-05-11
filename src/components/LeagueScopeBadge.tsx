export function LeagueScopeBadge({ scope }: { scope?: "major" | "all" | null }) {
  if (!scope) return null;
  const isMajor = scope === "major";
  const cls = isMajor
    ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
    : "bg-slate-500/15 text-slate-300 border-slate-500/30";
  const label = isMajor ? "⭐ Major Leagues" : "🌍 All Leagues";
  return (
    <span className={`inline-flex items-center px-2 h-6 rounded-md border text-[10px] font-semibold whitespace-nowrap ${cls}`}>
      {label}
    </span>
  );
}
