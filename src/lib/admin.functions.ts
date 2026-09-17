import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAdmin } from "./admin-auth.server";
import { setApiKeyForSlot, getApiKeySlotStatus } from "./isports.server";
import { setOddsApiKeys, getOddsApiKeysStatus } from "./oddsapi.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const TokenInput = z.object({ accessToken: z.string().min(20) });

export const getAdminApiStatus = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => TokenInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin(data.accessToken);
    const slots = await getApiKeySlotStatus();
    const hasKey = slots.slot1 || slots.slot2;
    return { hasKey, live: hasKey, error: hasKey ? null : "no key", slots };
  });

export const setAdminApiKey = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: z.string().min(20), slot: z.union([z.literal(1), z.literal(2)]), key: z.string().max(200) }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin(data.accessToken);
    await setApiKeyForSlot(data.slot, data.key);
    return { ok: true };
  });

export const getAdminEngineSettings = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => TokenInput.parse(d))
  .handler(async ({ data }) => {
    await requireAdmin(data.accessToken);
    const { DEFAULT_SPORT_KEYS } = await import("./oddsapi.server");
    const { data: settings } = await supabaseAdmin.from("engine_settings").select("*").eq("id", true).maybeSingle();
    const oddsKeysStatus = await getOddsApiKeysStatus();
    return {
      dataEngine: (settings?.data_engine as "isports" | "dual_free") ?? "isports",
      sportKeys: (settings?.sport_keys as string[] | null) ?? DEFAULT_SPORT_KEYS,
      oddsApiTotalKeys: oddsKeysStatus.totalKeys,
      oddsApiAvailableKeys: oddsKeysStatus.availableKeys,
      oddsApiExhaustedKeys: oddsKeysStatus.exhaustedKeys,
    };
  });

export const setAdminDataEngine = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: z.string().min(20), dataEngine: z.enum(["isports", "dual_free"]) }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin(data.accessToken);
    const { error } = await supabaseAdmin.from("engine_settings").upsert({ id: true, data_engine: data.dataEngine, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setAdminSportKeys = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: z.string().min(20), sportKeys: z.array(z.string().min(1)).min(1).max(40) }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin(data.accessToken);
    const { error } = await supabaseAdmin.from("engine_settings").upsert({ id: true, sport_keys: data.sportKeys, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setAdminOddsApiKeys = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: z.string().min(20), keys: z.array(z.string().min(1)).max(10) }).parse(d))
  .handler(async ({ data }) => {
    await requireAdmin(data.accessToken);
    await setOddsApiKeys(data.keys);
    return { ok: true };
  });
