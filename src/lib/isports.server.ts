// Server-only iSportsAPI client. Never import from client code.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BASE = "http://api.isportsapi.com/sport/football";

// In-memory cache of key statuses (now including the key VALUE itself, sourced
// from api_key_status.api_key) to avoid a DB roundtrip on every call.
let statusCache: { fetchedAt: number; rows: { key_index: number; exhausted_at: string | null; active: boolean; api_key: string | null }[] } | null = null;
const STATUS_TTL_MS = 30_000;

function utcDayKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

async function getKeyStatuses() {
  if (statusCache && Date.now() - statusCache.fetchedAt < STATUS_TTL_MS) return statusCache.rows;
  const { data } = await supabaseAdmin.from("api_key_status").select("key_index, exhausted_at, active, api_key");
  let rows = (data ?? []) as { key_index: number; exhausted_at: string | null; active: boolean; api_key: string | null }[];

  // Ensure both rows exist.
  const missing: number[] = [];
  for (const idx of [1, 2]) {
    if (!rows.find((r) => r.key_index === idx)) missing.push(idx);
  }
  if (missing.length) {
    await supabaseAdmin.from("api_key_status").upsert(
      missing.map((key_index) => ({ key_index, active: true, exhausted_at: null, updated_at: new Date().toISOString() })),
    );
    for (const key_index of missing) rows.push({ key_index, active: true, exhausted_at: null, api_key: null });
  }

  // Daily auto-reset: if exhausted_at is from a previous UTC day, clear it.
  const today = utcDayKey(new Date());
  const toReset = rows.filter((r) => r.exhausted_at && utcDayKey(new Date(r.exhausted_at)) !== today);
  if (toReset.length) {
    await supabaseAdmin.from("api_key_status").upsert(
      toReset.map((r) => ({ key_index: r.key_index, active: true, exhausted_at: null, updated_at: new Date().toISOString() })),
    );
    for (const r of toReset) {
      r.active = true;
      r.exhausted_at = null;
      console.log(`[iSportsAPI] daily reset for key ${r.key_index}`);
    }
  }

  statusCache = { fetchedAt: Date.now(), rows };
  return rows;
}

function invalidateStatusCache() { statusCache = null; }

/** Resolve the key for a slot: DB-stored value (set via Settings page) wins, else env var fallback. */
async function keyForIndex(idx: 1 | 2): Promise<string | undefined> {
  const rows = await getKeyStatuses();
  const dbKey = rows.find((r) => r.key_index === idx)?.api_key;
  if (dbKey) return dbKey;
  if (idx === 1) return process.env.ISPORTS_API_KEY || undefined;
  return process.env.ISPORTS_API_KEY_2 || undefined;
}

// Manual override: when set, get() will use only this key (no failover).
let forcedKey: 1 | 2 | null = null;
export function setForcedKey(idx: 1 | 2 | null) {
  forcedKey = idx;
  if (idx) console.log(`[iSportsAPI] forced key ${idx} for this request scope`);
}

async function isExhausted(idx: 1 | 2): Promise<boolean> {
  const rows = await getKeyStatuses();
  const r = rows.find((x) => x.key_index === idx);
  if (!r) return false;
  return !r.active || !!r.exhausted_at;
}

async function markExhausted(idx: 1 | 2) {
  await supabaseAdmin.from("api_key_status").upsert({
    key_index: idx,
    exhausted_at: new Date().toISOString(),
    active: false,
    updated_at: new Date().toISOString(),
  });
  invalidateStatusCache();
}

async function recordFailover() {
  await supabaseAdmin.from("api_usage").insert({ endpoint: "__failover" });
}

function isQuotaResponse(json: any, httpStatus: number): boolean {
  if (httpStatus === 429) return true;
  if (json && typeof json === "object") {
    const code = json.code;
    if (code === 10 || code === "10") return true;
    const msg = String(json.message ?? "").toLowerCase();
    if ((code === 2 || code === "2") && (msg.includes("trial") || msg.includes("200") || msg.includes("quota") || msg.includes("limit"))) return true;
  }
  return false;
}

async function tryWithKey<T = any>(idx: 1 | 2, path: string, params: Record<string, string>): Promise<{ ok: true; json: T } | { ok: false; quota: boolean; reason: string }> {
  const k = await keyForIndex(idx);
  if (!k) return { ok: false, quota: false, reason: `ISPORTS_API_KEY${idx === 2 ? "_2" : ""} not configured` };
  const qs = new URLSearchParams({ api_key: k, ...params }).toString();
  const url = `${BASE}${path}?${qs}`;
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch {
    if (!res.ok) return { ok: false, quota: false, reason: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    return { ok: false, quota: false, reason: `non-JSON response` };
  }
  if (isQuotaResponse(json, res.status)) {
    return { ok: false, quota: true, reason: `quota exceeded (key ${idx})` };
  }
  if (!res.ok) return { ok: false, quota: false, reason: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  if (json.code !== 0 && json.code !== undefined) {
    return { ok: false, quota: false, reason: `code=${json.code}: ${json.message ?? "unknown"}` };
  }
  // Fire-and-forget API usage tracking.
  void supabaseAdmin.from("api_usage").insert({ endpoint: path }).then(({ error }) => {
    if (error) console.warn(`[api_usage] insert failed: ${error.message}`);
  });
  return { ok: true, json };
}

async function get<T = any>(path: string, params: Record<string, string>): Promise<T> {
  // Manual override: use only the forced key, no failover.
  if (forcedKey) {
    const result = await tryWithKey<T>(forcedKey, path, params);
    if (result.ok) return result.json;
    if (result.quota) await markExhausted(forcedKey);
    console.error(`[iSportsAPI] ${path} forced key ${forcedKey} failed: ${result.reason}`);
    throw new Error(`iSportsAPI ${path} (forced key ${forcedKey}): ${result.reason}`);
  }
  // Determine starting key: prefer 1, but skip if marked exhausted.
  const primaryExhausted = await isExhausted(1);
  const secondaryExhausted = await isExhausted(2);

  const order: (1 | 2)[] = primaryExhausted ? [2, 1] : [1, 2];
  let lastReason = "no key available";
  let attemptedFailover = false;

  for (let i = 0; i < order.length; i++) {
    const idx = order[i];
    if (idx === 1 && primaryExhausted) continue;
    if (idx === 2 && secondaryExhausted && !primaryExhausted) {
      // both exhausted
      lastReason = "both keys exhausted";
      continue;
    }
    const result = await tryWithKey<T>(idx, path, params);
    if (result.ok) return result.json;
    lastReason = result.reason;
    if (result.quota) {
      await markExhausted(idx);
      // If we just exhausted key 1 and key 2 is available, log a failover.
      if (idx === 1 && i + 1 < order.length && !attemptedFailover) {
        const nextIdx = order[i + 1];
        const otherK = await keyForIndex(nextIdx);
        if (otherK) {
          attemptedFailover = true;
          console.log(`[iSportsAPI] switching to key ${nextIdx} after key 1 quota`);
          await recordFailover();
        }
      }
      continue; // try next key
    }
    // non-quota error: don't try the second key, fail fast.
    console.error(`[iSportsAPI] ${path} key ${idx} failed: ${result.reason}`);
    throw new Error(`iSportsAPI ${path}: ${result.reason}`);
  }
  console.error(`[iSportsAPI] ${path} all keys exhausted: ${lastReason}`);
  throw new Error(`iSportsAPI ${path} failed: ${lastReason}`);
}

export type ScheduleMatch = {
  matchId: string;
  leagueId: string;
  leagueName?: string;
  homeId?: string;
  awayId?: string;
  homeName: string;
  awayName: string;
  matchTime: number; // unix seconds
  raw: any;
};

/** Schedule by date (YYYY-MM-DD). Returns ALL leagues for that date. */
export async function fetchScheduleByDate(date: string): Promise<ScheduleMatch[]> {
  const { data: cached } = await supabaseAdmin
    .from("analysis_cache")
    .select("raw, fetched_at")
    .eq("match_id", `__schedule_${date}`)
    .maybeSingle();
  let payload: any;
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < 30 * 60 * 1000) {
    payload = cached.raw;
  } else {
    payload = await get<any>("/schedule", { date });
    await supabaseAdmin.from("analysis_cache").upsert({
      match_id: `__schedule_${date}`,
      raw: payload,
      fetched_at: new Date().toISOString(),
    });
  }
  let list: any[] = [];
  if (Array.isArray(payload?.data)) list = payload.data;
  else if (Array.isArray(payload?.data?.schedule)) list = payload.data.schedule;
  else if (Array.isArray(payload?.data?.matches)) list = payload.data.matches;
  else if (Array.isArray(payload?.results)) list = payload.results;
  if (!list.length) {
    console.warn(`[iSportsAPI] schedule for ${date} returned 0 matches.`);
  }
  return list
    .map((m: any) => ({
      matchId: String(m.matchId ?? m.id ?? ""),
      leagueId: String(m.leagueId ?? ""),
      leagueName: m.leagueName ?? m.league ?? undefined,
      homeId: m.homeId ? String(m.homeId) : undefined,
      awayId: m.awayId ? String(m.awayId) : undefined,
      homeName: String(m.homeName ?? m.home ?? "Home"),
      awayName: String(m.awayName ?? m.away ?? "Away"),
      matchTime: Number(m.matchTime ?? m.time ?? 0),
      raw: m,
    }))
    .filter((m: ScheduleMatch) => m.matchId);
}

async function getOddsMainPayload(matchId: string): Promise<any> {
  const cacheKey = `__odds_main_${matchId}`;
  const { data: cached } = await supabaseAdmin
    .from("analysis_cache")
    .select("raw, fetched_at")
    .eq("match_id", cacheKey)
    .maybeSingle();
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < 60 * 60 * 1000) {
    return cached.raw;
  }
  try {
    const payload = await get<any>("/odds/main", { matchId });
    await supabaseAdmin.from("analysis_cache").upsert({
      match_id: cacheKey,
      raw: payload,
      fetched_at: new Date().toISOString(),
    });
    return payload;
  } catch (e) {
    console.warn(`[getOddsMainPayload] /odds/main failed for ${matchId}:`, (e as any)?.message);
    return null;
  }
}

/**
 * Check if a match has real 1X2 odds from at least one bookmaker on /odds/main.
 * Fails open (returns true) on transport errors so a flaky odds endpoint doesn't wipe
 * out a scan.
 */
export async function hasMainOdds(matchId: string): Promise<boolean> {
  const payload = await getOddsMainPayload(matchId);
  if (!payload) return true; // fail open on fetch failure
  const rows = payload?.data?.europeOdds;
  return Array.isArray(rows) && rows.length > 0;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type LiveOdds = {
  matchWinner?: { oH: number; oD: number; oA: number; bookmakers: number };
  goals25?: { oOver: number; oUnder: number; bookmakers: number };
};

/**
 * Real, per-match live bookmaker odds — pulled from /odds/main (same endpoint hasMainOdds
 * checks), NOT from /analysis. The /analysis payload's homeOdds/awayOdds fields turned out
 * to be each team's historical per-match odds logs, not the current fixture's live price,
 * and /analysis carries no matchId to safely match a row to "this" match anyway. This is
 * the only source of odds trustworthy enough to compute real EV against.
 *
 * europeOdds row shape: matchId,companyId,initH,initD,initA,instH,instD,instA,timestamp,bool,int
 *   — already decimal odds. Uses the *instant* (current) columns, median across bookmakers.
 * overUnder row shape: matchId,companyId,initTotal,initOver,initUnder,instTotal,instOver,instUnder,timestamp,bool,int
 *   — prices are Hong Kong format (decimal = HK + 1). Only rows quoting exactly a 2.5 total
 *   line are used, since comparing our model's "over 2.5" probability against a different
 *   line's price would be comparing two different bets.
 */
export async function fetchLiveOdds(matchId: string): Promise<LiveOdds> {
  const payload = await getOddsMainPayload(matchId);
  const result: LiveOdds = {};
  if (!payload?.data) return result;

  const europeRows: string[] = Array.isArray(payload.data.europeOdds) ? payload.data.europeOdds : [];
  const hs: number[] = [], ds: number[] = [], as: number[] = [];
  for (const row of europeRows) {
    const c = String(row).split(",");
    const h = Number(c[5]), d = Number(c[6]), a = Number(c[7]);
    if (Number.isFinite(h) && h >= 1.01 && Number.isFinite(d) && d >= 1.01 && Number.isFinite(a) && a >= 1.01) {
      hs.push(h); ds.push(d); as.push(a);
    }
  }
  // Require at least 2 bookmakers agreeing on usable prices before trusting the median.
  if (hs.length >= 2) {
    result.matchWinner = { oH: median(hs), oD: median(ds), oA: median(as), bookmakers: hs.length };
  }

  const ouRows: string[] = Array.isArray(payload.data.overUnder) ? payload.data.overUnder : [];
  const overs: number[] = [], unders: number[] = [];
  for (const row of ouRows) {
    const c = String(row).split(",");
    const totalLine = Number(c[5]); // instant total line for this bookmaker
    if (!Number.isFinite(totalLine) || Math.abs(totalLine - 2.5) > 0.01) continue;
    const oHk = Number(c[6]), uHk = Number(c[7]);
    if (Number.isFinite(oHk) && Number.isFinite(uHk)) {
      overs.push(oHk + 1);
      unders.push(uHk + 1);
    }
  }
  if (overs.length >= 2) {
    result.goals25 = { oOver: median(overs), oUnder: median(unders), bookmakers: overs.length };
  }
  return result;
}

/** Match analysis with 12h cache. Refresh forces a re-fetch. */
export async function fetchMatchAnalysis(matchId: string, refresh = false): Promise<any> {
  if (!refresh) {
    const { data: cached } = await supabaseAdmin
      .from("analysis_cache")
      .select("raw, fetched_at")
      .eq("match_id", matchId)
      .maybeSingle();
    if (cached && Date.now() - new Date(cached.fetched_at).getTime() < 12 * 3600 * 1000) {
      return cached.raw;
    }
  }
  const data = await get<any>("/analysis", { matchId });
  await supabaseAdmin.from("analysis_cache").upsert({
    match_id: matchId,
    raw: data,
    fetched_at: new Date().toISOString(),
  });
  return data;
}

export type ResultRow = {
  matchId: string;
  homeScore: number | null;
  awayScore: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  status: string | null;
};

/** FT results sourced from /schedule (which includes scores for finished games). */
export async function fetchResultsByDate(date: string): Promise<ResultRow[]> {
  const cacheKey = `__schedule_${date}`;
  let payload: any;
  const { data: cached } = await supabaseAdmin
    .from("analysis_cache")
    .select("raw, fetched_at")
    .eq("match_id", cacheKey)
    .maybeSingle();
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < 30 * 60 * 1000) {
    payload = cached.raw;
  } else {
    payload = await get<any>("/schedule", { date });
    await supabaseAdmin.from("analysis_cache").upsert({
      match_id: cacheKey,
      raw: payload,
      fetched_at: new Date().toISOString(),
    });
  }

  let list: any[] = [];
  if (Array.isArray(payload?.data)) list = payload.data;
  else if (Array.isArray(payload?.data?.schedule)) list = payload.data.schedule;
  else if (Array.isArray(payload?.data?.matches)) list = payload.data.matches;
  else if (Array.isArray(payload?.data?.list)) list = payload.data.list;
  else if (Array.isArray(payload?.results)) list = payload.results;
  else if (Array.isArray(payload?.list)) list = payload.list;

  const isFinished = (s: any, homeScore?: number | null, awayScore?: number | null): boolean => {
    if (s == null) return false;
    if (typeof s === "number") {
      if (s === -1) return true;
      if (s === -2) return homeScore != null && awayScore != null;
      return false;
    }
    const str = String(s).toUpperCase();
    if (str === "-1" || str === "FT" || str === "FINISHED" || str === "FULL_TIME" || str === "FULL-TIME" || str === "AET" || str === "PEN") return true;
    if (str === "-2") return homeScore != null && awayScore != null;
    return false;
  };

  const num = (v: any): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

  return list
    .map((m: any) => {
      const rawStatus = m.status ?? m.matchStatus ?? m.state;
      return {
        matchId: String(m.matchId ?? m.id ?? m.match_id ?? ""),
        homeScore: num(m.homeScore ?? m.homeFtScore ?? m.homeGoals ?? m.home_score ?? (Array.isArray(m.score) ? m.score[0] : undefined)),
        awayScore: num(m.awayScore ?? m.awayFtScore ?? m.awayGoals ?? m.away_score ?? (Array.isArray(m.score) ? m.score[1] : undefined)),
        homeCorners: num(m.homeCorner ?? m.homeCorners ?? m.home_corner),
        awayCorners: num(m.awayCorner ?? m.awayCorners ?? m.away_corner),
        status: rawStatus != null ? String(rawStatus) : null,
        _rawStatus: rawStatus,
      };
    })
    .filter((r: any) => r.matchId && isFinished(r._rawStatus, r.homeScore, r.awayScore))
    .map(({ _rawStatus, ...r }: any) => r);
}

/** Set (or clear, with an empty string) the DB-stored API key for a slot. Used by the Settings page. */
export async function setApiKeyForSlot(idx: 1 | 2, key: string): Promise<void> {
  await supabaseAdmin.from("api_key_status").upsert({
    key_index: idx,
    api_key: key.trim() || null,
    // Setting a fresh key should also clear any stale exhausted/inactive flag.
    exhausted_at: null,
    active: true,
    updated_at: new Date().toISOString(),
  });
  invalidateStatusCache();
}

/** Whether a key is currently configured for a slot (DB or env), without exposing the value. */
export async function getApiKeySlotStatus(): Promise<{ slot1: boolean; slot2: boolean; slot1Source: "db" | "env" | "none"; slot2Source: "db" | "env" | "none" }> {
  const rows = await getKeyStatuses();
  const r1 = rows.find((r) => r.key_index === 1);
  const r2 = rows.find((r) => r.key_index === 2);
  const slot1Source: "db" | "env" | "none" = r1?.api_key ? "db" : process.env.ISPORTS_API_KEY ? "env" : "none";
  const slot2Source: "db" | "env" | "none" = r2?.api_key ? "db" : process.env.ISPORTS_API_KEY_2 ? "env" : "none";
  return { slot1: slot1Source !== "none", slot2: slot2Source !== "none", slot1Source, slot2Source };
}
