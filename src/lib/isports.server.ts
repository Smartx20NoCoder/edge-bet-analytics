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
  if (!res.ok) throw new Error(`iSportsAPI ${path} failed: ${res.status}`);
  const json = (await res.json()) as any;
  if (json.code !== 0 && json.code !== undefined) {
    throw new Error(`iSportsAPI ${path} returned code=${json.code} msg=${json.message ?? ""}`);
  }
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

export async function fetchSchedule(opts: { leagueId?: string } = {}): Promise<ScheduleMatch[]> {
  const params: Record<string, string> = {};
  if (opts.leagueId) params.leagueId = opts.leagueId;
  const data = await get<{ data: any[] }>("/schedule", params);
  const list = Array.isArray(data?.data) ? data.data : [];
  return list
    .map((m) => ({
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
    .filter((m) => m.matchId);
}

export async function fetchMatchAnalysis(matchId: string): Promise<any> {
  // Cache for 6h
  const { data: cached } = await supabaseAdmin
    .from("analysis_cache")
    .select("raw, fetched_at")
    .eq("match_id", matchId)
    .maybeSingle();
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < 6 * 3600 * 1000) {
    return cached.raw;
  }
  const data = await get<any>("/analysis", { matchId });
  await supabaseAdmin.from("analysis_cache").upsert({
    match_id: matchId,
    raw: data,
    fetched_at: new Date().toISOString(),
  });
  return data;
}
