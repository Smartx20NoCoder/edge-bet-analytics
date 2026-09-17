import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./admin-auth.server";

export const getEngineSettings = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: z.string().min(20) }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin(data.accessToken);
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { getOddsApiKeysStatus, DEFAULT_SPORT_KEYS } = await import("./oddsapi.server");
  const { data } = await supabaseAdmin.from("engine_settings").select("*").eq("id", true).maybeSingle();
  const oddsKeysStatus = await getOddsApiKeysStatus();
  return {
    dataEngine: (data?.data_engine as "isports" | "dual_free") ?? "isports",
    sportKeys: (data?.sport_keys as string[] | null) ?? DEFAULT_SPORT_KEYS,
    oddsApiTotalKeys: oddsKeysStatus.totalKeys,
    oddsApiAvailableKeys: oddsKeysStatus.availableKeys,
    oddsApiExhaustedKeys: oddsKeysStatus.exhaustedKeys,
  };
});

export const setDataEngine = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: z.string().min(20), dataEngine: z.enum(["isports", "dual_free"]) }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin(data.accessToken);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("engine_settings").upsert({ id: true, data_engine: data.dataEngine, updated_at: new Date().toISOString() });
    return { ok: true };
  });

export const setSportKeys = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: z.string().min(20), sportKeys: z.array(z.string().min(1)).min(1).max(40) }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin(data.accessToken);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("engine_settings").upsert({ id: true, sport_keys: data.sportKeys, updated_at: new Date().toISOString() });
    return { ok: true };
  });

// Replaces the ENTIRE key list with the given keys (not additive) — matches how the
// Settings UI textarea works: paste all your keys, one per line, and save. This resets
// each key's exhausted_at to null (a freshly-saved key is assumed usable), which is
// correct for adding a new key but means re-saving an already-exhausted key here will
// make it look available again until the next real quota check fails.
export const setOddsApiKeysList = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: z.string().min(20), keys: z.array(z.string().min(1)).max(10) }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin(data.accessToken);
    const { setOddsApiKeys } = await import("./oddsapi.server");
    await setOddsApiKeys(data.keys);
    return { ok: true };
  });
