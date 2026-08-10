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

async function keyForIndex(idx: 1 | 2): Promise<string | undefined> {
  const rows = await getKeyStatuses();
  const dbKey = rows.find((r) => r.key_index === idx)?.api_key;
  if (dbKey) return dbKey;
  if (idx === 1) return process.env.ISPORTS_API_KEY || undefined;
  return process.env.ISPORTS_API_KEY_2 || undefined;
}

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

// ---- Request spacing (throttle) ----
// iSportsAPI doesn't publicly document a per-second/burst limit for the trial tier, but
// real-world behavior (scans stalling partway through ~40-50 matches when fired back to
// back) strongly suggests one exists. Every real network call funnels through here
// (get() -> tryWithKey()), so this single choke point staggers ALL calls app-wide -
// schedule, analysis, and odds - regardless of which higher-level function triggered them.
// Cache hits never reach this code, so cached matches aren't slowed down by it.
// 350ms is a conservative guess, not a documented number - safe to tune down if scans
// stay reliable, or up if 429s persist.
const MIN_CALL_INTERVAL_MS = 350;
let lastCallAt = 0;
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
async function throttle() {
  const wait = lastCallAt + MIN_CALL_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

/**
 * Real permanent exhaustion of the trial's DAILY call allowance (resets at UTC midnight,
 * handled by the daily-reset logic above). Distinct from a transient per-second rate limit
 * - conflating the two was a real bug: a burst-rate 429 was being treated identically to
 * "you're out of calls for today," marking the key dead and potentially failing over or
 * aborting a scan over what was actually just a momentary throttle.
 */
function isDailyQuotaResponse(json: any): boolean {
  if (json && typeof json === "object") {
    const code = json.code;
    if (code === 10 || code === "10") return true;
    const msg = String(json.message ?? "").toLowerCase();
    if ((code === 2 || code === "2") && (msg.includes("trial") || msg.includes("200") || msg.includes("quota") || msg.includes("limit"))) return true;
  }
  return false;
}

/** A transient "too many requests too fast" signal - should be retried with backoff, never
 * treated as daily exhaustion. HTTP 429 is the only firm, universal signal available here;
 * iSportsAPI doesn't document a body-level throttle code to check alongside it. */
function isRateLimitedResponse(httpStatus: number): boolean {
  return httpStatus === 429;
}

async function tryWithKey<T = any>(idx: 1 | 2, path: string, params: Record<string, string>): Promise<{ ok: true; json: T } | { ok: false; quota: boolean; rateLimited: boolean; reason: string }> {
  const k = await keyForIndex(idx);
  if (!k) return { ok: false, quota: false, rateLimited: false, reason: `ISPORTS_API_KEY${idx === 2 ? "_2" : ""} not configured` };
  await throttle();
  const qs = new URLSearchParams({ api_key: k, ...params }).toString();
  const url = `${BASE}${path}?${qs}`;
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch {
    if (isRateLimitedResponse(res.status)) return { ok: false, quota: false, rateLimited: true, reason: `HTTP 429 (rate limited)` };
    if (!res.ok) return { ok: false, quota: false, rateLimited: false, reason: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    return { ok: false, quota: false, rateLimited: false, reason: `non-JSON response` };
  }
  if (isRateLimitedResponse(res.status)) {
    return { ok: false, quota: false, rateLimited: true, reason: `HTTP 429 (rate limited, key ${idx})` };
  }
  if (isDailyQuotaResponse(json)) {
    return { ok: false, quota: true, rateLimited: false, reason: `daily quota exceeded (key ${idx})` };
  }
  if (!res.ok) return { ok: false, quota: false, rateLimited: false, reason: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  if (json.code !== 0 && json.code !== undefined) {
    return { ok: false, quota: false, rateLimited: false, reason: `code=${json.code}: ${json.message ?? "unknown"}` };
  }
  void supabaseAdmin.from("api_usage").insert({ endpoint: path }).then(({ error }) => {
    if (error) console.warn(`[api_usage] insert failed: ${error.message}`);
  });
  return { ok: true, json };
}

/** Retries a single key on rate-limit responses with exponential backoff (not on daily
 * quota or other errors - those fail fast/failover immediately, retrying won't help). */
async function tryWithKeyAndBackoff<T = any>(idx: 1 | 2, path: string, params: Record<string, string>): Promise<{ ok: true; json: T } | { ok: false; quota: boolean; reason: string }> {
  const BACKOFFS_MS = [500, 1000, 2000];
  let last: Awaited<ReturnType<typeof tryWithKey<T>>> | null = null;
  for (let attempt = 0; attempt <= BACKOFFS_MS.length; attempt++) {
    const result = await tryWithKey<T>(idx, path, params);
    if (result.ok || !result.rateLimited) return result;
    last = result;
    if (attempt < BACKOFFS_MS.length) {
      console.warn(`[iSportsAPI] ${path} key ${idx} rate-limited, retrying in ${BACKOFFS_MS[attempt]}ms (attempt ${attempt + 1}/${BACKOFFS_MS.length})`);
      await sleep(BACKOFFS_MS[attempt]);
    }
  }
  return last!;
}

async function get<T = any>(path: string, params: Record<string, string>): Promise<T> {
  if (forcedKey) {
    const result = await tryWithKeyAndBackoff<T>(forcedKey, path, params);
    if (result.ok) return result.json;
    if (result.quota) await markExhausted(forcedKey);
    console.error(`[iSportsAPI] ${path} forced key ${forcedKey} failed: ${result.reason}`);
    throw new Error(`iSportsAPI ${path} (forced key ${forcedKey}): ${result.reason}`);
  }
  const primaryExhausted = await isExhausted(1);
  const secondaryExhausted = await isExhausted(2);

  const order: (1 | 2)[] = primaryExhausted ? [2, 1] : [1, 2];
  let lastReason = "no key available";
  let attemptedFailover = false;

  for (let i = 0; i < order.length; i++) {
    const idx = order[i];
    if (idx === 1 && primaryExhausted) continue;
    if (idx === 2 && secondaryExhausted && !primaryExhausted) {
      lastReason = "both keys exhausted";
      continue;
    }
    const result = await tryWithKeyAndBackoff<T>(idx, path, params);
    if (result.ok) return result.json;
    lastReason = result.reason;
    if (result.quota) {
      await markExhausted(idx);
      if (idx === 1 && i + 1 < order.length && !attemptedFailover) {
        const nextIdx = order[i + 1];
        const otherK = await keyForIndex(nextIdx);
        if (otherK) {
          attemptedFailover = true;
          console.log(`[iSportsAPI] switching to key ${nextIdx} after key 1 quota`);
          await recordFailover();
        }
      }
      continue;
    }
    // non-quota error (including a rate limit that persisted through all backoff retries):
    // don't try the second key, fail fast - switching keys doesn't fix a rate limit, which
    // is almost certainly IP/account-wide, not per-key.
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
  matchTime: number;
  raw: any;
};

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

export async function hasMainOdds(matchId: string): Promise<boolean> {
  const payload = await getOddsMainPayload(matchId);
  if (!payload) return true;
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
  ahHomePlus?: { odds: number; bookmakers: number };
  ahAwayPlus?: { odds: number; bookmakers: number };
};

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
  if (hs.length >= 2) {
    result.matchWinner = { oH: median(hs), oD: median(ds), oA: median(as), bookmakers: hs.length };
  }

  const hRows: string[] = Array.isArray(payload.data.handicap) ? payload.data.handicap : [];
  const homePlus: number[] = [], awayPlus: number[] = [];
  for (const row of hRows) {
    const c = String(row).split(",");
    const line = Number(c[5]);
    const homeHk = Number(c[6]), awayHk = Number(c[7]);
    if (!Number.isFinite(line)) continue;
    // BUGFIX: the handicap `line` value in this feed is stated relative to the AWAY team,
    // not home (confirmed by cross-checking against the real 1X2 fair-value benchmark on
    // real matches — a home favorite's rows show positive lines, an away favorite's rows
    // show negative lines, which only makes sense if positive = "away is the underdog").
    // So: "Home +0.5" (home's mirrored line is +0.5) comes from rows where the AWAY line
    // is -0.5 (away favored by half a goal), using the home price column. "Away +0.5"
    // comes directly from rows where the away line IS +0.5, using the away price column.
    if (Math.abs(line + 0.5) < 0.001 && Number.isFinite(homeHk)) homePlus.push(homeHk + 1);
    if (Math.abs(line - 0.5) < 0.001 && Number.isFinite(awayHk)) awayPlus.push(awayHk + 1);
  }
  if (homePlus.length >= 2) result.ahHomePlus = { odds: median(homePlus), bookmakers: homePlus.length };
  if (awayPlus.length >= 2) result.ahAwayPlus = { odds: median(awayPlus), bookmakers: awayPlus.length };

  const ouRows: string[] = Array.isArray(payload.data.overUnder) ? payload.data.overUnder : [];
  const overs: number[] = [], unders: number[] = [];
  for (const row of ouRows) {
    const c = String(row).split(",");
    const totalLine = Number(c[5]);
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

export async function setApiKeyForSlot(idx: 1 | 2, key: string): Promise<void> {
  await supabaseAdmin.from("api_key_status").upsert({
    key_index: idx,
    api_key: key.trim() || null,
    exhausted_at: null,
    active: true,
    updated_at: new Date().toISOString(),
  });
  invalidateStatusCache();
}

export async function getApiKeySlotStatus(): Promise<{ slot1: boolean; slot2: boolean; slot1Source: "db" | "env" | "none"; slot2Source: "db" | "env" | "none" }> {
  const rows = await getKeyStatuses();
  const r1 = rows.find((r) => r.key_index === 1);
  const r2 = rows.find((r) => r.key_index === 2);
  const slot1Source: "db" | "env" | "none" = r1?.api_key ? "db" : process.env.ISPORTS_API_KEY ? "env" : "none";
  const slot2Source: "db" | "env" | "none" = r2?.api_key ? "db" : process.env.ISPORTS_API_KEY_2 ? "env" : "none";
  return { slot1: slot1Source !== "none", slot2: slot2Source !== "none", slot1Source, slot2Source };
}
