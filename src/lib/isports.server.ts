// Server-only iSportsAPI client. Never import from client code.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BASE = "http://api.isportsapi.com/sport/football";

function keyForIndex(idx: 1 | 2): string | undefined {
  if (idx === 1) return process.env.ISPORTS_API_KEY || undefined;
  return process.env.ISPORTS_API_KEY_2 || undefined;
}

// In-memory cache of key statuses to avoid a DB roundtrip on every call.
let statusCache: { fetchedAt: number; rows: { key_index: number; exhausted_at: string | null; active: boolean }[] } | null = null;
const STATUS_TTL_MS = 30_000;

async function getKeyStatuses() {
  if (statusCache && Date.now() - statusCache.fetchedAt < STATUS_TTL_MS) return statusCache.rows;
  const { data } = await supabaseAdmin.from("api_key_status").select("key_index, exhausted_at, active");
  statusCache = { fetchedAt: Date.now(), rows: (data ?? []) as any };
  return statusCache.rows;
}

function invalidateStatusCache() { statusCache = null; }

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
  const k = keyForIndex(idx);
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
        const otherK = keyForIndex(order[i + 1]);
        if (otherK) {
          attemptedFailover = true;
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

/**
 * Check if a match has 1X2 (home/draw/away) odds available from at least 1 bookmaker.
 * Uses /odds/main with a 1h cache. Fails open (returns true) on transport errors so
 * a flaky odds endpoint doesn't wipe out a scan.
 */
export async function hasMainOdds(matchId: string): Promise<boolean> {
  const cacheKey = `__odds_main_${matchId}`;
  let payload: any;
  const { data: cached } = await supabaseAdmin
    .from("analysis_cache")
    .select("raw, fetched_at")
    .eq("match_id", cacheKey)
    .maybeSingle();
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < 60 * 60 * 1000) {
    payload = cached.raw;
  } else {
    try {
      payload = await get<any>("/odds/main", { matchId });
      await supabaseAdmin.from("analysis_cache").upsert({
        match_id: cacheKey,
        raw: payload,
        fetched_at: new Date().toISOString(),
      });
    } catch (e) {
      console.warn(`[hasMainOdds] /odds/main failed for ${matchId}, failing open:`, (e as any)?.message);
      return true;
    }
  }
  // Find any bookmaker entry with a 3-tuple of numeric 1X2 odds.
  const stack: any[] = [payload?.data ?? payload];
  let depth = 0;
  while (stack.length && depth < 5000) {
    depth++;
    const node = stack.pop();
    if (node == null) continue;
    if (Array.isArray(node)) {
      // Bookmaker rows often look like [companyId, home, draw, away, ...] or nested arrays.
      if (node.length >= 3) {
        // Look for 3 finite numbers >= 1.0 in the first 6 entries (handles different orderings).
        const nums = node.slice(0, 6).map((v) => Number(v)).filter((n) => Number.isFinite(n) && n >= 1.0);
        if (nums.length >= 3) return true;
      }
      for (const item of node) if (item && typeof item === "object") stack.push(item);
    } else if (typeof node === "object") {
      // Common shapes: { europeOdds: { [companyId]: [...] } } or { "1x2": {...} }
      const keys = Object.keys(node);
      const oddsKey = keys.find((k) => /europe|1x2|main|moneyline|ml/i.test(k));
      if (oddsKey && node[oddsKey] && typeof node[oddsKey] === "object") {
        const inner = node[oddsKey];
        if (Object.keys(inner).length > 0) return true;
      }
      for (const k of keys) stack.push(node[k]);
    }
  }
  return false;
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
