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

  async function save(nextEnabled: boolean) {
    setSaving(true);
    try {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session?.access_token) throw new Error("Authentication required");
      await setFn({
        data: {
          accessToken: session.session.access_token,
          enabled: nextEnabled,
          interval: nextEnabled ? "24h" : "off",
        },
      });
      await qc.invalidateQueries({ queryKey: ["results-automation"] });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="glass rounded-xl p-6 space-y-4">
      <div>
        <h2 className="text-sm uppercase tracking-widest text-muted-foreground">Results Update Automation</h2>
        <p className="mt-2 text-xs text-muted-foreground">
          Updates existing pending predictions only. It never starts a prediction scan or discovers new matches.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          disabled={saving}
          onClick={() => save(false)}
          className={`px-3 h-8 rounded-md text-xs border transition-colors ${
            !enabled ? "bg-neon/15 border-neon/50 text-neon" : "border-border text-muted-foreground hover:text-foreground"
          }`}
        >
          Off
        </button>
        <button
          disabled={saving}
          onClick={() => save(true)}
          className={`px-3 h-8 rounded-md text-xs border transition-colors ${
            enabled ? "bg-neon/15 border-neon/50 text-neon" : "border-border text-muted-foreground hover:text-foreground"
          }`}
        >
          Daily (24 hours)
        </button>
      </div>

      <div className="rounded-lg border border-border/60 p-3 text-xs text-muted-foreground space-y-1">
        <p><span className="font-semibold text-foreground">Current:</span> {enabled ? "Daily (24 hours)" : "Off"}</p>
        <p><span className="font-semibold text-foreground">Schedule:</span> Vercel triggers the results update once per day.</p>
        <p><span className="font-semibold text-foreground">Manual backup:</span> the existing Update Results action remains available at any time.</p>
        {q.data?.lastRun && <p><span className="font-semibold text-foreground">Last automated run:</span> {new Date(q.data.lastRun).toLocaleString()}</p>}
      </div>

      {q.isError && <p className="text-xs text-destructive">Unable to load automation settings. Sign in again if your admin session expired.</p>}
    </div>
  );
}
