import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const getEngineSettings = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { getOddsApiKeyStatus, DEFAULT_SPORT_KEYS } = await import("./oddsapi.server");
  const { data } = await supabaseAdmin.from("engine_settings").select("*").eq("id", true).maybeSingle();
  const oddsKeyStatus = await getOddsApiKeyStatus();
  return {
    dataEngine: (data?.data_engine as "isports" | "dual_free") ?? "isports",
    sportKeys: (data?.sport_keys as string[] | null) ?? DEFAULT_SPORT_KEYS,
    oddsApiKeyConfigured: oddsKeyStatus.hasKey,
    oddsApiKeySource: oddsKeyStatus.source,
  };
});

export const setDataEngine = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ dataEngine: z.enum(["isports", "dual_free"]) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("engine_settings").upsert({ id: true, data_engine: data.dataEngine, updated_at: new Date().toISOString() });
    return { ok: true };
  });

export const setSportKeys = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ sportKeys: z.array(z.string().min(1)).min(1).max(40) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("engine_settings").upsert({ id: true, sport_keys: data.sportKeys, updated_at: new Date().toISOString() });
    return { ok: true };
  });

export const setOddsApiKey = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ key: z.string().max(200) }).parse(d))
  .handler(async ({ data }) => {
    const { setOddsApiKey: setOddsApiKeyImpl } = await import("./oddsapi.server");
    await setOddsApiKeyImpl(data.key);
    return { ok: true };
  });
