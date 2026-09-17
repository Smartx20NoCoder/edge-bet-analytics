import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getAdminApiStatus, setAdminApiKey, getAdminEngineSettings, setAdminDataEngine, setAdminSportKeys, setAdminOddsApiKeys } from "@/lib/admin.functions";
import { supabase } from "@/integrations/supabase/client";
import { CheckCircle2, XCircle, Lock, AlertTriangle } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getEngineSettings, setDataEngine, setSportKeys, setOddsApiKeysList } from "@/lib/engine-settings.functions";

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
  const fn = useServerFn(setAdminApiKey);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  async function save() {
    if (!value.trim()) return;
    setSaving(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Authentication required");
      await fn({ data: { accessToken: session.session.access_token, slot, key: value.trim() } });
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

function DataEngineCard() {
  const qc = useQueryClient();
  const fn = useServerFn(getAdminEngineSettings);
  const setEngineFn = useServerFn(setAdminDataEngine);
  const setKeysFn = useServerFn(setAdminSportKeys);
  const setOddsKeysFn = useServerFn(setAdminOddsApiKeys);

  const q = useQuery({ queryKey: ["engine-settings"], queryFn: async () => { const { data: session } = await supabase.auth.getSession(); if (!session.session?.access_token) throw new Error("Authentication required"); return fn({ data: { accessToken: session.session.access_token } }); } });
  const [sportKeysText, setSportKeysText] = useState("");
  const [oddsKeysText, setOddsKeysText] = useState("");
  const [savingKeys, setSavingKeys] = useState(false);
  const [savingOddsKeys, setSavingOddsKeys] = useState(false);
  const [oddsKeysSavedAt, setOddsKeysSavedAt] = useState<number | null>(null);

  const currentEngine = q.data?.dataEngine ?? "isports";

  async function switchEngine(engine: "isports" | "dual_free") {
    const { data: session } = await supabase.auth.getSession();
    if (!session.session?.access_token) throw new Error("Authentication required");
    await setEngineFn({ data: { accessToken: session.session.access_token, dataEngine: engine } });
    qc.invalidateQueries({ queryKey: ["engine-settings"] });
  }

  async function saveSportKeys() {
    const keys = sportKeysText.split(",").map((s) => s.trim()).filter(Boolean);
    if (!keys.length) return;
    setSavingKeys(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Authentication required");
      await setKeysFn({ data: { accessToken: session.session.access_token, sportKeys: keys } });
      qc.invalidateQueries({ queryKey: ["engine-settings"] });
    } finally {
      setSavingKeys(false);
    }
  }

  async function saveOddsKeys() {
    const keys = oddsKeysText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!keys.length) return;
    setSavingOddsKeys(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Authentication required");
      await setOddsKeysFn({ data: { accessToken: session.session.access_token, keys } });
      setOddsKeysText("");
      setOddsKeysSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ["engine-settings"] });
    } finally {
      setSavingOddsKeys(false);
    }
  }

  return (
    <div className="glass rounded-xl p-6 space-y-5">
      <h2 className="text-sm uppercase tracking-widest text-muted-foreground">Data Engine</h2>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => switchEngine("isports")}
                className={`px-3 h-8 rounded-md text-xs border transition-colors ${currentEngine === "isports" ? "bg-neon/15 border-neon/50 text-neon" : "border-border text-muted-foreground hover:text-foreground"}`}
              >
                iSportsAPI (Statistical Model)
              </button>
              <button
                onClick={() => switchEngine("dual_free")}
                className={`px-3 h-8 rounded-md text-xs border transition-colors ${currentEngine === "dual_free" ? "bg-gold/15 border-gold/50 text-gold" : "border-border text-muted-foreground hover:text-foreground"}`}
              >
                Odds API (Sharp vs Soft)
              </button>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Line-shopping against Pinnacle's fair price — a different strategy than the iSports statistical model, not a drop-in replacement for it.
            </p>
          </div>

          <div className="space-y-1.5 pt-3 border-t border-border/60">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Odds API Keys (rotation)</span>
              <span className={(q.data?.oddsApiAvailableKeys ?? 0) === 0 ? "text-[11px] text-destructive" : "text-[11px] text-neon"}>
                {q.data?.oddsApiTotalKeys
                  ? `${q.data.oddsApiAvailableKeys} of ${q.data.oddsApiTotalKeys} available${q.data.oddsApiExhaustedKeys ? ` (${q.data.oddsApiExhaustedKeys} exhausted this month)` : ""}`
                  : "None configured"}
              </span>
            </div>
            <Textarea
              placeholder={"Paste one key per line — replaces the entire list on save.\ne.g.\nabc123...\ndef456..."}
              value={oddsKeysText}
              onChange={(e) => setOddsKeysText(e.target.value)}
              className="font-mono text-xs min-h-[80px]"
            />
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">
                Supports rotation across multiple keys (currently used for a 2-key, 1,000/month combined setup — add a 3rd line for 1,500/month). Saving replaces the whole list, so paste ALL keys you want active, not just a new one.
              </p>
              <Button onClick={saveOddsKeys} disabled={savingOddsKeys || !oddsKeysText.trim()} size="sm">
                {savingOddsKeys ? "Saving…" : "Save"}
              </Button>
            </div>
            {oddsKeysSavedAt && Date.now() - oddsKeysSavedAt < 4000 && (
              <p className="text-[11px] text-neon">Saved. Key list replaced — a scan will confirm which are usable.</p>
            )}
          </div>

          <div className="space-y-1.5 pt-3 border-t border-border/60">
            <span className="text-xs font-medium text-muted-foreground">Sport Keys (comma-separated)</span>
            <Input
              placeholder={(q.data?.sportKeys ?? []).join(", ")}
              value={sportKeysText}
              onChange={(e) => setSportKeysText(e.target.value)}
              className="font-mono text-xs"
            />
            <div className="flex items-center justify-between">
              <p className="text-[11px] text-muted-foreground">
                e.g. soccer_epl, soccer_spain_la_liga — see the-odds-api.com/sports for the full list.
              </p>
              <Button onClick={saveSportKeys} disabled={savingKeys || !sportKeysText.trim()} size="sm">
                {savingKeys ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Settings() {
  const fn = useServerFn(getAdminApiStatus);
  const q = useQuery({ queryKey: ["api-status"], queryFn: async () => { const { data: session } = await supabase.auth.getSession(); if (!session.session?.access_token) throw new Error("Authentication required"); return fn({ data: { accessToken: session.session.access_token } }); } });
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

      <DataEngineCard />
        
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
        <p><span className="text-gold font-semibold">Match Outcome Engine</span> — Match Winner and Over 2.5 Goals, now an ensemble of four real signals, each weighted by how much data actually backs it (a signal with little/no data just contributes ~0 — never overrides the base model): (1) team form (win/draw/loss rates, home/away split) — always full weight; (2) recency-weighted form, computed fresh from individual games with recent results weighted higher — only when ≥6 individual games are available; (3) head-to-head between these exact two teams — weight scales with number of past meetings, 0 if none; (4) league table rank gap — only when both teams' ranks are real parseable numbers. Double chance and corners were removed entirely — no real market price exists for those in this API's data.</p>
        <p><span className="text-neon font-semibold">Expected Value</span> — computed after filtering, from real per-match bookmaker odds (/odds/main, median across bookmakers), not estimated from historical data. Match Winner and Over 2.5 get EV whenever a live price is found (Over 2.5 only when a bookmaker quotes exactly a 2.5 total line). No reliable price found → confidence only, no EV shown, rather than a guessed number.</p>
        <p><span className="text-gold font-semibold">Hedge to +0.5 AH</span> — a Match Winner pick under 60% confidence gets automatically converted to a real Asian Handicap +0.5 (win-or-draw) pick when either: EV is under +10%, or EV is +10%+ but real odds are 2.60+ (long odds at low confidence still carry too much variance). Only applied when a bookmaker is actually quoting exactly that 0.5 line — never a derived/estimated price. Backtested on 7 days of real graded picks: 6/10 win rate and +€1.29 profit as plain Match Winner vs. 9/10 win rate and +€6.54 profit hedged, on the same 10 matches (flat €1 stakes). Small sample — treat as promising, not proven.</p>
      </div>

      <div className="glass rounded-xl p-6 text-xs text-muted-foreground">
        <p>Data caching: per-match analysis cached server-side for 6 hours to optimize quota.</p>
        <p>Errors are isolated per match — a single bad fixture won't fail an entire scan.</p>
      </div>
    </section>
  );
}
