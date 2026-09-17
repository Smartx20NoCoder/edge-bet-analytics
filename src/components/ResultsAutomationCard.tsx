import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { getResultsAutomation, setResultsAutomation } from "@/lib/results-automation.functions";

export function ResultsAutomationCard() {
  const qc = useQueryClient();
  const getFn = useServerFn(getResultsAutomation);
  const setFn = useServerFn(setResultsAutomation);
  const [saving, setSaving] = useState(false);
  const q = useQuery({
    queryKey: ["results-automation"],
    queryFn: async () => {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Authentication required");
      return getFn({ data: { accessToken: session.session.access_token } });
    },
  });
  const enabled = q.data?.enabled ?? false;
  const interval = q.data?.interval ?? "24h";

  async function save(nextEnabled: boolean, nextInterval = interval) {
    setSaving(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Authentication required");
      await setFn({ data: { accessToken: session.session.access_token, enabled: nextEnabled, interval: nextInterval as "off" | "4h" | "6h" | "12h" | "24h" } });
      await qc.invalidateQueries({ queryKey: ["results-automation"] });
    } finally { setSaving(false); }
  }

  return (
    <div className="glass rounded-xl p-6 space-y-4">
      <div>
        <h2 className="text-sm uppercase tracking-widest text-muted-foreground">Results Update Automation</h2>
        <p className="mt-2 text-xs text-muted-foreground">Updates existing pending predictions only. It never starts a prediction scan or discovers new matches.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {["off", "4h", "6h", "12h", "24h"].map((value) => (
          <button key={value} disabled={saving} onClick={() => save(value !== "off", value)} className={`px-3 h-8 rounded-md text-xs border transition-colors ${interval === value && (value === "off" ? !enabled : enabled) ? "bg-neon/15 border-neon/50 text-neon" : "border-border text-muted-foreground hover:text-foreground"}`}>
            {value === "off" ? "Off" : `Every ${value.replace("h", " hours")}`}
          </button>
        ))}
      </div>
      <div className="rounded-lg border border-border/60 p-3 text-xs text-muted-foreground space-y-1">
        <p><span className="font-semibold text-foreground">Current:</span> {enabled ? `Every ${interval.replace("h", " hours")}` : "Off"}</p>
        <p><span className="font-semibold text-foreground">Manual backup:</span> the existing Update Results action remains available.</p>
        <p><span className="font-semibold text-foreground">Vercel Hobby:</span> its cron trigger is daily, so only the 24-hour option is currently executed automatically. The 4/6/12-hour settings are stored for future higher-frequency scheduling.</p>
        {q.data?.lastRun && <p><span className="font-semibold text-foreground">Last automated run:</span> {new Date(q.data.lastRun).toLocaleString()}</p>}
      </div>
      {q.isError && <p className="text-xs text-destructive">Unable to load automation settings. Sign in again if your admin session expired.</p>}
      <Button variant="outline" size="sm" disabled={saving || !enabled} onClick={() => save(false, "off")}>{saving ? "Saving…" : "Disable automation"}</Button>
    </div>
  );
}
