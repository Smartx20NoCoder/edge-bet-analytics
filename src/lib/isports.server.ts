// Server-only iSportsAPI client. Never import from client code.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BASE = "http://api.isportsapi.com/sport/football";

function key() {
  const k = process.env.ISPORTS_API_KEY;
  if (!k) throw new Error("ISPORTS_API_KEY not configured");
  return k;
}

async function get<T = any>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ api_key: key(), ...params }).toString();
  const url = `${BASE}${path}?${qs}`;
  const res = await fetch(url, { method: "GET" });
  const text = await res.text();
  if (!res.ok) {
    console.error(`[iSportsAPI] ${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
    throw new Error(`iSportsAPI ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  let json: any;
  try { json = JSON.parse(text); } catch {
    console.error(`[iSportsAPI] ${path} non-JSON response: ${text.slice(0, 300)}`);
    throw new Error(`iSportsAPI ${path} returned non-JSON response`);
  }
  if (json.code !== 0 && json.code !== undefined) {
    console.error(`[iSportsAPI] ${path} code=${json.code} msg=${json.message ?? ""}`);
    throw new Error(`iSportsAPI ${path} code=${json.code}: ${json.message ?? "unknown error"}`);
  }
  // Fire-and-forget API usage tracking.
  void supabaseAdmin.from("api_usage").insert({ endpoint: path }).then(({ error }) => {
    if (error) console.warn(`[api_usage] insert failed: ${error.message}`);
  });
  return json as T;
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
  // Cache schedules by date — they don't change much intra-day
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
  // Schedule payload shapes seen in the wild:
  //   { code:0, data:[ ... ] }
  //   { code:0, data:{ schedule:[ ... ] } }
  //   { code:0, data:{ matches:[ ... ] } }
  let list: any[] = [];
  if (Array.isArray(payload?.data)) list = payload.data;
  else if (Array.isArray(payload?.data?.schedule)) list = payload.data.schedule;
  else if (Array.isArray(payload?.data?.matches)) list = payload.data.matches;
  else if (Array.isArray(payload?.results)) list = payload.results;
  if (!list.length) {
    console.warn(`[iSportsAPI] schedule for ${date} returned 0 matches. Top-level keys:`,
      Object.keys(payload ?? {}), "data keys:", payload?.data && typeof payload.data === "object" ? Object.keys(payload.data) : typeof payload?.data);
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

/** FT results by date. The user's plan doesn't include /results, so we read
 *  finished matches out of the /schedule payload (which includes scores and
 *  status for completed games). Reuses the __schedule_${date} cache entry. */
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

  console.log(`[iSportsAPI] results-from-schedule ${date}: count=${list.length}`);
  if (list.length && list[0]) {
    console.log(`[iSportsAPI] schedule sample row keys=${JSON.stringify(Object.keys(list[0]))}`);
  }

  // Status detection: iSports uses numeric status codes; 3 = finished. Also accept string variants.
  const isFinished = (s: any): boolean => {
    if (s == null) return false;
    if (typeof s === "number") return s === 3 || s === -1;
    const str = String(s).toUpperCase();
    return str === "3" || str === "-1" || str === "FT" || str === "FINISHED" || str === "FULL_TIME" || str === "FULL-TIME" || str === "AET" || str === "PEN";
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
    .filter((r: any) => r.matchId && isFinished(r._rawStatus))
    .map(({ _rawStatus, ...r }: any) => r);
}
