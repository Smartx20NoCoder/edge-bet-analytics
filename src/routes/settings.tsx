import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { checkApiStatus, setApiKey } from "@/lib/predictions.functions";
import { CheckCircle2, XCircle, Lock, AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings · BetEdge AI" },
      { name: "description", content: "iSportsAPI status, integration health, and engine configuration for BetEdge AI." },
      { property: "og:title", content: "Settings · BetEdge AI" },
      { property: "og:description", content: "API status and engine configuration for BetEdge AI." },
      { property: "og:url", content: "/settings" },
    ],
    links: [{ rel: "canonical", href: "/settings" }],
  }),
  component: Settings,
});

function KeySlotInput({ slot, source }: { slot: 1 | 2; source: "db" | "env" | "none" }) {
  const qc = useQueryClient();
  const fn = useServerFn(setApiKey);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function save() {
    if (!value.trim()) return;
    setSaving(true);
    try {
      await fn({ data: { slot, key: value.trim() } });
      setValue("");
      setSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ["api-status"] });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">Key slot {slot}</span>
        <span className={source === "none" ? "text-[11px] text-destructive" : "text-[11px] text-neon"}>
          {source === "db" ? "Set via this page" : source === "env" ? "Set via environment variable" : "Not configured"}
        </span>
      </div>
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder={source !== "none" ? "•••••••••••••• (paste new key to replace)" : "Paste iSportsAPI key"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="font-mono text-sm"
        />
        <Button onClick={save} disabled={saving || !value.trim()} size="sm">
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {savedAt && Date.now() - savedAt < 4000 && (
        <p className="text-[11px] text-neon">Saved. This slot is now active for scans.</p>
      )}
    </div>
  );
}

function Settings() {
  const fn = useServerFn(checkApiStatus);
  const q = useQuery({ queryKey: ["api-status"], queryFn: () => fn() });
  const slots = q.data?.slots;

  return (
    <section className="mx-auto max-w-3xl px-4 sm:px-6 py-10 space-y-6">
      <h1 className="text-3xl font-bold">Settings</h1>

      <div className="glass rounded-xl p-6">
        <h2 className="text-sm uppercase tracking-widest text-muted-foreground mb-3">iSportsAPI Status</h2>
        <div className="flex items-center gap-3">
          {q.isLoading ? <span className="text-muted-foreground">Checking…</span> :
           q.data?.live ? <><CheckCircle2 className="text-neon" /> <span className="font-semibold text-neon">Live · API responding</span></> :
           q.data?.hasKey ? <><XCircle className="text-destructive" /> <span className="text-destructive">Key set but request failed: {q.data?.error}</span></> :
           <><XCircle className="text-destructive" /> <span className="text-destructive">No API key configured</span></>}
        </div>
        <div className="mt-4 text-xs text-muted-foreground flex items-start gap-2">
          <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0 text-neon" />
          <span>Keys are stored server-side and never sent to the browser. Scans use slot 1 first, and automatically fail over to slot 2 if slot 1 hits its quota.</span>
        </div>
        <div className="mt-2 text-xs text-gold flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>This app has no login system, so anyone who has this page's URL can view slot status and set new keys. Don't share this link.</span>
        </div>
      </div>

      <div className="glass rounded-xl p-6 space-y-5">
        <h2 className="text-sm uppercase tracking-widest text-muted-foreground">API Keys</h2>
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            <KeySlotInput slot={1} source={slots?.slot1Source ?? "none"} />
            <KeySlotInput slot={2} source={slots?.slot2Source ?? "none"} />
          </>
        )}
      </div>

      <div className="glass rounded-xl p-6 space-y-2 text-sm">
        <h2 className="text-sm uppercase tracking-widest text-muted-foreground">Engines</h2>
        <p><span className="text-neon font-semibold">Corner Engine</span> — Over 6.5 corners; weighted formula on attacking, conceded, shot-volume and tempo. Threshold: ≥75% confidence and ≥8 projected corners. Top 5 only.</p>
        <p><span className="text-gold font-semibold">Match Outcome Engine</span> — Match winner, double chance, Asian handicap, Over 1.5 goals. Combines form, scoring rates, strength index and Poisson goal model. Threshold: ≥75% confidence; friendlies and youth competitions filtered.</p>
        <p><span className="text-neon font-semibold">Expected Value</span> — computed only for Match Winner picks, using unblended model probability against the real bookmaker price. Other bet types show confidence only — there's no real market price in this API's data to compare against for those.</p>
      </div>

      <div className="glass rounded-xl p-6 text-xs text-muted-foreground">
        <p>Data caching: per-match analysis cached server-side for 6 hours to optimize quota.</p>
        <p>Errors are isolated per match — a single bad fixture won't fail an entire scan.</p>
      </div>
    </section>
  );
}
