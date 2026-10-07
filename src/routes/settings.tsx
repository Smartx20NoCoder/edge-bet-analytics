import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getAdminApiStatus, getAdminEngineSettings, setAdminDataEngine, setAdminSportKeys, setAdminOddsApiKeys } from "@/lib/admin.functions";
import { supabase } from "@/integrations/supabase/client";
import { LogOut } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ResultsAutomationCard } from "@/components/ResultsAutomationCard";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings · BetEdge AI" },
      { name: "description", content: "Goaloo status, integration health, and engine configuration for BetEdge AI." },
      { property: "og:title", content: "Settings · BetEdge AI" },
      { property: "og:description", content: "API status and engine configuration for BetEdge AI." },
      { property: "og:url", content: "/settings" },
    ],
    links: [{ rel: "canonical", href: "/settings" }],
  }),
  component: Settings,
});

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
                Goaloo (Statistical Model)
              </button>
              <button
                onClick={() => switchEngine("dual_free")}
                className={`px-3 h-8 rounded-md text-xs border transition-colors ${currentEngine === "dual_free" ? "bg-gold/15 border-gold/50 text-gold" : "border-border text-muted-foreground hover:text-foreground"}`}
              >
                Odds API (Sharp vs Soft)
              </button>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Line-shopping against Pinnacle's fair price — a different strategy than the Goaloo statistical model, not a drop-in replacement for it.
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
  const navigate = useNavigate();
  const fn = useServerFn(getAdminApiStatus);
  const [signingOut, setSigningOut] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      await supabase.auth.signOut();
      await navigate({ to: "/admin-login" });
    } finally {
      setSigningOut(false);
    }
  }
  const q = useQuery({ queryKey: ["api-status"], queryFn: async () => { const { data: session } = await supabase.auth.getSession(); if (!session.session?.access_token) throw new Error("Authentication required"); return fn({ data: { accessToken: session.session.access_token } }); } });

  return (
    <section className="mx-auto max-w-3xl px-4 sm:px-6 py-10 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Settings</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={signOut}
          disabled={signingOut}
          className="shrink-0"
        >
          <LogOut className="h-4 w-4 mr-2" />
          {signingOut ? "Signing out…" : "Sign out"}
        </Button>
      </div>

      <div className="glass rounded-xl p-6">
        <h2 className="text-sm uppercase tracking-widest mb-3">Goaloo Data Source</h2>
        <p className="text-sm">{q.isLoading ? "Checking…" : q.data?.live ? "Available · No API key or trial renewal required" : `Currently unavailable: ${q.data?.error ?? "Check again shortly"}`}</p>
        <p className="mt-2 text-xs text-muted-foreground">Fixtures, match statistics, live bookmaker prices and full-time results come from Goaloo. The Odds API remains a separate scan option.</p>
      </div>

      <ResultsAutomationCard />

      <DataEngineCard />
        
      <div className="glass rounded-xl p-6 space-y-2 text-sm">
        <h2 className="text-sm uppercase tracking-widest text-muted-foreground">Engines</h2>
        <p><span className="text-gold font-semibold">Match Outcome Engine</span> — Match Winner and Over 2.5 Goals, now an ensemble of four real signals, each weighted by how much data actually backs it (a signal with little/no data just contributes ~0 — never overrides the base model): (1) team form (win/draw/loss rates, home/away split) — always full weight; (2) recency-weighted form, computed fresh from individual games with recent results weighted higher — only when ≥6 individual games are available; (3) head-to-head between these exact two teams — weight scales with number of past meetings, 0 if none; (4) league table rank gap — only when both teams' ranks are real parseable numbers. Double chance and corners were removed entirely — no real market price exists for those in this API's data.</p>
        <p><span className="text-neon font-semibold">Expected Value</span> — computed after filtering, from real per-match bookmaker odds (Goaloo, median across bookmakers), not estimated from historical data. Match Winner and Over 2.5 get EV whenever a live price is found (Over 2.5 only when a bookmaker quotes exactly a 2.5 total line). No reliable price found → confidence only, no EV shown, rather than a guessed number.</p>
        <p><span className="text-gold font-semibold">Hedge to +0.5 AH</span> — a Match Winner pick under 60% confidence gets automatically converted to a real Asian Handicap +0.5 (win-or-draw) pick when either: EV is under +10%, or EV is +10%+ but real odds are 2.60+ (long odds at low confidence still carry too much variance). Only applied when a bookmaker is actually quoting exactly that 0.5 line — never a derived/estimated price. Backtested on 7 days of real graded picks: 6/10 win rate and +€1.29 profit as plain Match Winner vs. 9/10 win rate and +€6.54 profit hedged, on the same 10 matches (flat €1 stakes). Small sample — treat as promising, not proven.</p>
      </div>

      <div className="glass rounded-xl p-6 text-xs text-muted-foreground">
        <p>Data caching: per-match analysis cached server-side for 6 hours; fixture lists for 5 minutes and prices for 5 minutes.</p>
        <p>Errors are isolated per match — a single bad fixture won't fail an entire scan.</p>
      </div>
    </section>
  );
}
