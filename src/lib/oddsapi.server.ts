// Server-only The Odds API (v4) client. Never import from client code.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BASE = "https://api.the-odds-api.com/v4";

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// A bookmaker's price that hasn't refreshed recently can look like a "discrepancy" against
// Pinnacle when it's really just stale and about to snap back into line — a classic false
// positive for sharp-vs-soft comparisons. Every bookmaker object in The Odds API v4's
// response carries its own `last_update` (ISO 8601). 30 minutes is a starting point, not a
// tuned number — worth revisiting once real picks accumulate under it.
const MAX_STALENESS_MINUTES = 30;
function isFresh(lastUpdate: string | undefined): boolean {
  if (!lastUpdate) return false;
  const ageMs = Date.now() - new Date(lastUpdate).getTime();
  return ageMs >= 0 && ageMs <= MAX_STALENESS_MINUTES * 60 * 1000;
}

// ---- Multi-key rotation ----
// Supports N rotating keys (2 today, expandable to 3+) instead of a single key. The Odds
// API's free tier resets MONTHLY, not daily like iSportsAPI's trial — exhaustion tracking
// here is month-keyed, not UTC-day-keyed. Detection uses the `x-requests-remaining`
// response header The Odds API returns on every call (0 or missing-with-401 = exhausted)
// rather than a body-level code, since that's the documented mechanism for this API.
type OddsKeyEntry = { key: string; exhausted_at: string | null };

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
}

async function getKeyEntries(): Promise<OddsKeyEntry[]> {
  const { data } = await supabaseAdmin.from("engine_settings").select("odds_api_keys, odds_api_key").eq("id", true).maybeSingle();
  let entries: OddsKeyEntry[] = Array.isArray(data?.odds_api_keys) ? data!.odds_api_keys as OddsKeyEntry[] : [];
  if (!entries.length && data?.odds_api_key) entries = [{ key: data.odds_api_key as string, exhausted_at: null }];
  if (!entries.length && process.env.ODDS_API_KEY) entries = [{ key: process.env.ODDS_API_KEY, exhausted_at: null }];

  // Monthly auto-reset: clear any exhausted flag from a previous calendar month.
  const thisMonth = monthKey(new Date());
  const toReset = entries.filter((e) => e.exhausted_at && monthKey(new Date(e.exhausted_at)) !== thisMonth);
  if (toReset.length) {
    entries = entries.map((e) => (toReset.includes(e) ? { ...e, exhausted_at: null } : e));
    await supabaseAdmin.from("engine_settings").upsert({ id: true, odds_api_keys: entries, updated_at: new Date().toISOString() });
    console.log(`[oddsapi] monthly reset applied to ${toReset.length} key(s)`);
  }
  return entries;
}

async function markKeyExhausted(key: string): Promise<void> {
  const entries = await getKeyEntries();
  const updated = entries.map((e) => (e.key === key ? { ...e, exhausted_at: new Date().toISOString() } : e));
  await supabaseAdmin.from("engine_settings").upsert({ id: true, odds_api_keys: updated, updated_at: new Date().toISOString() });
}

/** Ordered list of currently-usable (non-exhausted) keys to try, in order. */
async function getAvailableKeys(): Promise<string[]> {
  const entries = await getKeyEntries();
  return entries.filter((e) => !e.exhausted_at).map((e) => e.key);
}

export async function setOddsApiKeys(keys: string[]): Promise<void> {
  const cleaned = keys.map((k) => k.trim()).filter(Boolean);
  const entries: OddsKeyEntry[] = cleaned.map((key) => ({ key, exhausted_at: null }));
  await supabaseAdmin.from("engine_settings").upsert({ id: true, odds_api_keys: entries, updated_at: new Date().toISOString() });
}

export async function getOddsApiKeysStatus(): Promise<{ totalKeys: number; availableKeys: number; exhaustedKeys: number }> {
  const entries = await getKeyEntries();
  const exhausted = entries.filter((e) => e.exhausted_at).length;
  return { totalKeys: entries.length, availableKeys: entries.length - exhausted, exhaustedKeys: exhausted };
}

/** Fetches a URL (with `{key}` substituted per attempt), rotating through available keys
 * on quota exhaustion. Rate-limit (429) retries the SAME key with backoff — switching keys
 * doesn't fix a rate limit, which is IP-scoped, not key-scoped. Quota exhaustion (detected
 * via the x-requests-remaining header, or a 401 with no remaining) rotates to the next key
 * and marks the exhausted one so it's skipped for the rest of the calendar month. */
async function fetchWithKeyRotation(buildUrl: (key: string) => string, label: string): Promise<{ res: Response; text: string }> {
  const keys = await getAvailableKeys();
  if (!keys.length) throw new Error("No Odds API keys configured or all are exhausted for this month.");

  const BACKOFFS_MS = [500, 1000, 2000];
  let lastErr = "";
  for (const key of keys) {
    let attempt = 0;
    while (true) {
      await throttle();
      const res = await fetch(buildUrl(key));
      const text = await res.text();
      const remaining = res.headers.get("x-requests-remaining");
      const quotaExhausted = (remaining !== null && Number(remaining) <= 0) || (res.status === 401 && remaining === null);
      if (quotaExhausted) {
        console.warn(`[oddsapi] ${label} key exhausted (remaining=${remaining ?? "n/a"}, status=${res.status}) — rotating to next key.`);
        await markKeyExhausted(key);
        lastErr = `key exhausted`;
        break; // try next key
      }
      if (res.status === 429 && attempt < BACKOFFS_MS.length) {
        console.warn(`[oddsapi] ${label} rate-limited, retrying in ${BACKOFFS_MS[attempt]}ms (attempt ${attempt + 1}/${BACKOFFS_MS.length})`);
        await sleep(BACKOFFS_MS[attempt]);
        attempt++;
        continue;
      }
      return { res, text }; // success or a non-quota/non-rate-limit failure — return as-is
    }
  }
  throw new Error(`OddsAPI ${label}: all ${keys.length} key(s) exhausted for this month (${lastErr}).`);
}

// Same preventive spacing added to isports.server.ts after real scan failures there —
// applied here proactively, before The Odds API has actually thrown an error, since the
// league count just grew and sequential unspaced calls are exactly what caused the
// iSportsAPI issue. 350ms matches the same conservative default; not a documented Odds
// API limit, just consistent precaution.
const MIN_CALL_INTERVAL_MS = 350;
let lastCallAt = 0;
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
async function throttle() {
  const wait = lastCallAt + MIN_CALL_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

export async function getSportKeys(): Promise<string[]> {
  const { data } = await supabaseAdmin.from("engine_settings").select("sport_keys").eq("id", true).maybeSingle();
  const keys = data?.sport_keys as string[] | null;
  return keys && keys.length ? keys : DEFAULT_SPORT_KEYS;
}

async function getEventsPayload(sportKey: string, markets: string): Promise<any[]> {
  const cacheKey = `__oddsapi_${sportKey}_${markets.replace(/,/g, "-")}`;
  const { data: cached } = await supabaseAdmin
    .from("analysis_cache")
    .select("raw, fetched_at")
    .eq("match_id", cacheKey)
    .maybeSingle();
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < 6 * 3600 * 1000) {
    return cached.raw as any[];
  }
  const { res, text } = await fetchWithKeyRotation(
    (key) => `${BASE}/sports/${sportKey}/odds?apiKey=${key}&regions=eu&markets=${markets}&oddsFormat=decimal`,
    `/sports/${sportKey}/odds`,
  );
  let json: any;
  try { json = JSON.parse(text); } catch {
    throw new Error(`OddsAPI /sports/${sportKey}/odds: non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    throw new Error(`OddsAPI /sports/${sportKey}/odds: HTTP ${res.status} — ${json?.message ?? text.slice(0, 200)}`);
  }
  await supabaseAdmin.from("analysis_cache").upsert({ match_id: cacheKey, raw: json, fetched_at: new Date().toISOString() });
  return json as any[];
}

export type OddsApiFixture = {
  matchId: string;
  leagueId: string;
  leagueName: string;
  homeName: string;
  awayName: string;
  matchTime: number;
  raw: any;
};

export async function fetchOddsApiFixtures(sportKeys: string[]): Promise<OddsApiFixture[]> {
  const out: OddsApiFixture[] = [];
  for (const sportKey of sportKeys) {
    let events: any[];
    try {
      // markets is h2h only now — totals was dropped (never produced a single Over 2.5
      // pick since this engine went live; Pinnacle/EU bookmakers apparently don't reliably
      // quote exactly the 2.5 line this needs, likely due to floating "main" totals per
      // match rather than a full ladder of lines) and spreads was already excluded for
      // quota reasons — see the note below. h2h-only roughly halves the remaining cost
      // again (1 market × 1 region instead of 2 × 1 per league).
      events = await getEventsPayload(sportKey, "h2h");
    } catch (e: any) {
      console.warn(`[fetchOddsApiFixtures] ${sportKey} failed: ${e?.message ?? e}`);
      continue;
    }
    for (const ev of events) {
      out.push({
        matchId: String(ev.id),
        leagueId: String(ev.sport_key ?? sportKey),
        leagueName: String(ev.sport_title ?? sportKey),
        homeName: String(ev.home_team ?? ""),
        awayName: String(ev.away_team ?? ""),
        matchTime: Math.floor(new Date(ev.commence_time).getTime() / 1000),
        raw: ev,
      });
    }
  }
  return out;
}

export type LiveOdds = {
  matchWinner?: { oH: number; oD: number; oA: number; bookmakers: number };
  goals25?: { oOver: number; oUnder: number; bookmakers: number };
  ahHomePlus?: { odds: number; bookmakers: number };
  ahAwayPlus?: { odds: number; bookmakers: number };
};

export function extractOddsApiLiveOdds(event: any, homeName: string, awayName: string): LiveOdds {
  const result: LiveOdds = {};
  const bookmakers: any[] = Array.isArray(event?.bookmakers) ? event.bookmakers : [];
  const hs: number[] = [], ds: number[] = [], as: number[] = [];
  const homePlus: number[] = [], awayPlus: number[] = [];
  const overs: number[] = [], unders: number[] = [];
  for (const bm of bookmakers) {
    const markets: any[] = Array.isArray(bm?.markets) ? bm.markets : [];
    for (const mkt of markets) {
      const outcomes: any[] = Array.isArray(mkt?.outcomes) ? mkt.outcomes : [];
      if (mkt.key === "h2h") {
        for (const o of outcomes) {
          const price = Number(o.price);
          if (!Number.isFinite(price) || price < 1.01) continue;
          if (o.name === homeName) hs.push(price);
          else if (o.name === awayName) as.push(price);
          else if (o.name === "Draw") ds.push(price);
        }
      } else if (mkt.key === "spreads") {
        for (const o of outcomes) {
          const price = Number(o.price);
          const point = Number(o.point);
          if (!Number.isFinite(price) || price < 1.01 || !Number.isFinite(point)) continue;
          if (o.name === homeName && Math.abs(point - 0.5) < 0.001) homePlus.push(price);
          if (o.name === awayName && Math.abs(point - 0.5) < 0.001) awayPlus.push(price);
        }
      } else if (mkt.key === "totals") {
        for (const o of outcomes) {
          const price = Number(o.price);
          const point = Number(o.point);
          if (!Number.isFinite(price) || price < 1.01 || Math.abs(point - 2.5) > 0.001) continue;
          if (o.name === "Over") overs.push(price);
          else if (o.name === "Under") unders.push(price);
        }
      }
    }
  }
  if (hs.length >= 2 && ds.length >= 2 && as.length >= 2) {
    result.matchWinner = { oH: median(hs), oD: median(ds), oA: median(as), bookmakers: hs.length };
  }
  if (homePlus.length >= 2) result.ahHomePlus = { odds: median(homePlus), bookmakers: homePlus.length };
  if (awayPlus.length >= 2) result.ahAwayPlus = { odds: median(awayPlus), bookmakers: awayPlus.length };
  if (overs.length >= 2 && unders.length >= 2) {
    result.goals25 = { oOver: median(overs), oUnder: median(unders), bookmakers: overs.length };
  }
  return result;
}

const SHARP_BOOK_KEY = "pinnacle";

type FairValueSide = { fairOdds: number; fairProb: number; otherOdds: number; otherBookCount: number };

function computeFairValue(pinnacleOdds: number | undefined, otherOddsForSameSide: number[]): FairValueSide | undefined {
  if (!pinnacleOdds || pinnacleOdds < 1.01 || otherOddsForSameSide.length < 2) return undefined;
  return { fairOdds: pinnacleOdds, fairProb: 1 / pinnacleOdds, otherOdds: median(otherOddsForSameSide), otherBookCount: otherOddsForSameSide.length };
}

export type OddsApiPrediction = {
  prediction_type: "match_winner" | "match_winner_hedged";
  selection: string;
  confidence: number;
  market_odds: number;
  model_probability: number;
  expected_value: number;
  reasons: string[];
  stats: Record<string, any>;
};

export function predictFromSharpFairValue(
  event: any,
  homeName: string,
  awayName: string,
  thresholds: { matchWinnerFloor?: number } = {},
): OddsApiPrediction[] {
  const matchWinnerFloor = thresholds.matchWinnerFloor ?? 49;
  const bookmakers: any[] = Array.isArray(event?.bookmakers) ? event.bookmakers : [];
  const pinnacle = bookmakers.find((b) => b.key === SHARP_BOOK_KEY);
  // A stale Pinnacle quote is an unreliable fair-value anchor — same principle as the
  // staleness check on the OTHER bookmakers below, just applied to the reference price
  // itself. No fresh Pinnacle price, no prediction for this match at all.
  if (!pinnacle || !isFresh(pinnacle.last_update)) return [];
  const out: OddsApiPrediction[] = [];

  const pinH2H = (pinnacle.markets ?? []).find((m: any) => m.key === "h2h");
  if (pinH2H) {
    const pOut = (pinH2H.outcomes ?? []).find((o: any) => o.name === homeName);
    const dOut = (pinH2H.outcomes ?? []).find((o: any) => o.name === "Draw");
    const aOut = (pinH2H.outcomes ?? []).find((o: any) => o.name === awayName);
    const pinH = Number(pOut?.price), pinD = Number(dOut?.price), pinA = Number(aOut?.price);
    if (pinH >= 1.01 && pinD >= 1.01 && pinA >= 1.01) {
      const iH = 1 / pinH, iD = 1 / pinD, iA = 1 / pinA;
      const sum = iH + iD + iA;
      const fairH = iH / sum, fairD = iD / sum, fairA = iA / sum;
      const otherH: number[] = [], otherA: number[] = [];
      for (const bm of bookmakers) {
        if (bm.key === SHARP_BOOK_KEY) continue;
        if (!isFresh(bm.last_update)) continue; // stale price — excluded from EV comparison
        const mkt = (bm.markets ?? []).find((m: any) => m.key === "h2h");
        if (!mkt) continue;
        const h = Number((mkt.outcomes ?? []).find((o: any) => o.name === homeName)?.price);
        const a = Number((mkt.outcomes ?? []).find((o: any) => o.name === awayName)?.price);
        if (h >= 1.01) otherH.push(h);
        if (a >= 1.01) otherA.push(a);
      }
      const homeFav = fairH >= fairA;
      const fairProb = homeFav ? fairH : fairA;
      const otherOdds = homeFav ? otherH : otherA;
      const fv = computeFairValue(homeFav ? pinH : pinA, otherOdds);
      const confidence = Math.round(fairProb * 1000) / 10;
      if (fv && confidence >= matchWinnerFloor) {
        const ev = Math.round((fairProb * fv.otherOdds - 1) * 10000) / 10000;
        const selection = homeFav ? "Home Win" : "Away Win";
        const base: OddsApiPrediction = {
          prediction_type: "match_winner",
          selection,
          confidence,
          market_odds: fv.otherOdds,
          model_probability: fairProb,
          expected_value: ev,
          reasons: [
            `Pinnacle fair value: H ${(fairH*100).toFixed(0)}% / D ${(fairD*100).toFixed(0)}% / A ${(fairA*100).toFixed(0)}% (from ${pinH.toFixed(2)}/${pinD.toFixed(2)}/${pinA.toFixed(2)} odds).`,
            `Consensus of ${fv.otherBookCount} other fresh bookmaker(s) (updated within ${MAX_STALENESS_MINUTES}m): ${fv.otherOdds.toFixed(2)} odds for ${selection}.`,
            `EV = (${(fairProb*100).toFixed(1)}% Pinnacle-fair prob × ${fv.otherOdds.toFixed(2)} consensus odds) − 1 = ${(ev*100).toFixed(1)}%.`,
            "Line-shopping strategy (sharp vs soft), not an independent stats-based prediction.",
          ],
          stats: { engine: "oddsapi_sharp_fair_value", fairH, fairD, fairA, pinnacleOdds: { pinH, pinD, pinA } },
        };
        const lowConfidence = confidence < 60;
        if (lowConfidence && (ev < 0.10 || (ev >= 0.10 && fv.otherOdds >= 2.60))) {
          const pinSpreads = (pinnacle.markets ?? []).find((m: any) => m.key === "spreads");
          const pinPlusOutcome = (pinSpreads?.outcomes ?? []).find((o: any) => o.name === (homeFav ? homeName : awayName) && Math.abs(Number(o.point) - 0.5) < 0.001);
          if (pinPlusOutcome) {
            const pinPlusOdds = Number(pinPlusOutcome.price);
            const otherPlus: number[] = [];
            for (const bm of bookmakers) {
              if (bm.key === SHARP_BOOK_KEY) continue;
              if (!isFresh(bm.last_update)) continue;
              const mkt = (bm.markets ?? []).find((m: any) => m.key === "spreads");
              const o = (mkt?.outcomes ?? []).find((x: any) => x.name === (homeFav ? homeName : awayName) && Math.abs(Number(x.point) - 0.5) < 0.001);
              const price = Number(o?.price);
              if (price >= 1.01) otherPlus.push(price);
            }
            if (pinPlusOdds >= 1.01 && otherPlus.length >= 2) {
              const pWinOrDraw = homeFav ? fairH + fairD : fairA + fairD;
              const otherPlusMedian = median(otherPlus);
              const ahEv = Math.round((pWinOrDraw * otherPlusMedian - 1) * 10000) / 10000;
              out.push({
                prediction_type: "match_winner_hedged",
                selection: homeFav ? "Home +0.5 (AH)" : "Away +0.5 (AH)",
                confidence: Math.round(pWinOrDraw * 1000) / 10,
                market_odds: otherPlusMedian,
                model_probability: pWinOrDraw,
                expected_value: ahEv,
                reasons: [...base.reasons, `Original Match Winner: ${confidence}% confidence, ${(ev*100).toFixed(1)}% EV, ${fv.otherOdds.toFixed(2)} odds — hedged to a real +0.5 line (Pinnacle-quoted) instead.`],
                stats: { ...base.stats, hedgedFrom: "match_winner" },
              });
            } else out.push(base);
          } else out.push(base);
        } else out.push(base);
      }
    }
  }

  // Over 2.5 Goals (totals) removed — never produced a single pick since this engine went
  // live, and the market fetch itself was dropped to save quota (see fetchOddsApiFixtures).
  // match_winner (+hedge, currently dormant since spreads is also unfetched) is the only
  // market this engine evaluates now.
  return out;
}

export type OddsApiResultRow = { matchId: string; homeScore: number | null; awayScore: number | null; homeCorners: null; awayCorners: null; status: string | null; };

export async function fetchOddsApiResults(sportKey: string, daysFrom = 3): Promise<OddsApiResultRow[]> {
  const cacheKey = `__oddsapi_scores_${sportKey}_${daysFrom}`;
  const { data: cached } = await supabaseAdmin.from("analysis_cache").select("raw, fetched_at").eq("match_id", cacheKey).maybeSingle();
  let json: any[];
  if (cached && Date.now() - new Date(cached.fetched_at).getTime() < 30 * 60 * 1000) {
    json = cached.raw as any[];
  } else {
    const { res, text } = await fetchWithKeyRotation(
      (key) => `${BASE}/sports/${sportKey}/scores?apiKey=${key}&daysFrom=${daysFrom}&dateFormat=iso`,
      `/sports/${sportKey}/scores`,
    );
    try { json = JSON.parse(text); } catch { throw new Error(`OddsAPI /sports/${sportKey}/scores: non-JSON response (HTTP ${res.status})`); }
    if (!res.ok) throw new Error(`OddsAPI /sports/${sportKey}/scores: HTTP ${res.status}`);
    await supabaseAdmin.from("analysis_cache").upsert({ match_id: cacheKey, raw: json, fetched_at: new Date().toISOString() });
  }
  const num = (v: any): number | null => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  return (json ?? [])
    .filter((ev: any) => ev.completed === true && Array.isArray(ev.scores))
    .map((ev: any) => {
      const homeScoreEntry = ev.scores.find((s: any) => s.name === ev.home_team);
      const awayScoreEntry = ev.scores.find((s: any) => s.name === ev.away_team);
      return { matchId: String(ev.id), homeScore: num(homeScoreEntry?.score), awayScore: num(awayScoreEntry?.score), homeCorners: null, awayCorners: null, status: "completed" };
    });
}

// ALL real domestic non-cup, non-international soccer leagues from The Odds API's
// in-season list — cups (FA Cup, DFB Pokal, Copa Libertadores/Sudamericana, Leagues Cup)
// and international competitions (Nations League) are still excluded, same reasoning as
// the isports engine: thinner/less consistent bookmaker coverage on those.
// 40 leagues x 30 days once-daily = 1,200/month. At 2 keys (1,000/month) this runs slightly
// short near month-end until reset — not catastrophic, just occasional late-month gaps. At
// 3 keys (1,500/month) it fits with ~300/month headroom. Recheck this math before scanning
// more than once/day or before dropping to fewer than 3 keys.
const DEFAULT_SPORT_KEYS = [
  "soccer_epl", "soccer_spain_la_liga", "soccer_italy_serie_a", "soccer_germany_bundesliga",
  "soccer_france_ligue_one", "soccer_netherlands_eredivisie", "soccer_portugal_primeira_liga",
  "soccer_usa_mls", "soccer_brazil_campeonato", "soccer_argentina_primera_division",
  "soccer_efl_champ", "soccer_uefa_champs_league_qualification",
  "soccer_poland_ekstraklasa", "soccer_italy_serie_b", "soccer_germany_bundesliga2", "soccer_belgium_first_div",
  "soccer_austria_bundesliga", "soccer_brazil_serie_b", "soccer_chile_campeonato", "soccer_china_superleague",
  "soccer_denmark_superliga", "soccer_england_league1", "soccer_england_league2", "soccer_finland_veikkausliiga",
  "soccer_france_ligue_two", "soccer_germany_liga3", "soccer_greece_super_league", "soccer_japan_j_league",
  "soccer_korea_kleague1", "soccer_league_of_ireland", "soccer_mexico_ligamx", "soccer_norway_eliteserien",
  "soccer_russia_premier_league", "soccer_saudi_arabia_pro_league", "soccer_spain_segunda_division", "soccer_spl",
  "soccer_sweden_allsvenskan", "soccer_sweden_superettan", "soccer_switzerland_superleague", "soccer_turkey_super_league",
];

export async function runDualFreeScan(opts: {
  timeframeHours: number;
  maxMatches: number;
  matchWinnerFloor?: number;
  over25Floor?: number;
  sportKeys?: string[];
  onEvent?: (evt: string, payload: any) => void;
}): Promise<{ analysisId: string | null; matchesAnalyzed: number; predictionsGenerated: number }> {
  const sportKeys = opts.sportKeys ?? (await getSportKeys());
  const send = opts.onEvent ?? (() => {});
  send("status", { message: `Fetching fixtures+odds for ${sportKeys.length} leagues via The Odds API…` });

  const fixtures = await fetchOddsApiFixtures(sportKeys);
  const now = Date.now();
  const windowEnd = now + opts.timeframeHours * 3600 * 1000;
  const candidates = fixtures
    .filter((f) => f.matchTime * 1000 > now && f.matchTime * 1000 <= windowEnd)
    .sort((a, b) => a.matchTime - b.matchTime)
    .slice(0, opts.maxMatches);

  send("status", { message: `${fixtures.length} total fixtures → ${candidates.length} within ${opts.timeframeHours}h window.` });

  let skippedExisting = 0;
  let finalCandidates = candidates;
  if (candidates.length) {
    const ids = candidates.map((c) => c.matchId);
    const { data: existing } = await supabaseAdmin.from("predictions").select("match_id").in("match_id", ids);
    const existingSet = new Set((existing ?? []).map((r: any) => String(r.match_id)));
    finalCandidates = candidates.filter((c) => !existingSet.has(c.matchId));
    skippedExisting = candidates.length - finalCandidates.length;
    if (skippedExisting) send("status", { message: `Skipping ${skippedExisting} already-predicted matches.` });
  }

  if (!finalCandidates.length) {
    send("error", { message: `No qualifying matches after filters. ${candidates.length ? "All were already predicted in earlier scans." : "Try widening the timeframe or check that Pinnacle-covered leagues are selected."}` });
    return { analysisId: null, matchesAnalyzed: 0, predictionsGenerated: 0 };
  }

  const allPreds: any[] = [];
  let i = 0;
  for (const m of finalCandidates) {
    i++;
    send("match", { index: i, total: finalCandidates.length, home: m.homeName, away: m.awayName, league: m.leagueName, matchId: m.matchId });
    try {
      const preds = predictFromSharpFairValue(m.raw, m.homeName, m.awayName, {
        matchWinnerFloor: opts.matchWinnerFloor,
      });
      for (const p of preds) {
        allPreds.push({
          engine: "match",
          prediction_type: p.prediction_type,
          selection: p.selection,
          confidence: p.confidence,
          risk_level: p.confidence >= 70 ? "low" : p.confidence >= 60 ? "medium" : "high",
          reasons: p.reasons,
          stats: p.stats,
          market_odds: p.market_odds,
          model_probability: p.model_probability,
          expected_value: p.expected_value,
          recommendation: `Lean ${p.selection} — ${p.expected_value >= 0 ? "+" : ""}${(p.expected_value * 100).toFixed(1)}% edge at ${p.market_odds.toFixed(2)} odds (sharp-vs-soft, Odds API).`,
          match_id: m.matchId,
          home_team: m.homeName,
          away_team: m.awayName,
          league_id: m.leagueId,
          league_name: m.leagueName,
          kickoff: new Date(m.matchTime * 1000).toISOString(),
        });
      }
      send("match_done", { index: i, total: finalCandidates.length, home: m.homeName, away: m.awayName, picks: preds.length });
    } catch (e: any) {
      send("match_error", { index: i, total: finalCandidates.length, home: m.homeName, away: m.awayName, error: e?.message ?? "failed" });
    }
  }

  if (!allPreds.length) {
    send("done", { analysisId: null, matchesAnalyzed: finalCandidates.length, predictionsGenerated: 0 });
    return { analysisId: null, matchesAnalyzed: finalCandidates.length, predictionsGenerated: 0 };
  }

  const avg = allPreds.reduce((s, p) => s + Number(p.confidence), 0) / allPreds.length;
  const { data: analysisRow, error: aErr } = await supabaseAdmin
    .from("analyses")
    .insert({
      league_id: null,
      league_name: null,
      matches_analyzed: finalCandidates.length,
      predictions_generated: allPreds.length,
      avg_confidence: Math.round(avg * 100) / 100,
      status: "completed",
      notes: JSON.stringify({ engine: "dual_free", sportKeys, skippedExisting }),
    })
    .select()
    .single();
  if (aErr || !analysisRow) throw new Error(aErr?.message ?? "analysis insert failed");

  await supabaseAdmin.from("predictions").insert(allPreds.map((p) => ({ ...p, analysis_id: analysisRow.id })));

  const { lockDailyBestPickIfNeeded } = await import("./predictions.functions");
  await lockDailyBestPickIfNeeded();

  send("done", { analysisId: analysisRow.id, matchesAnalyzed: finalCandidates.length, predictionsGenerated: allPreds.length });
  return { analysisId: analysisRow.id, matchesAnalyzed: finalCandidates.length, predictionsGenerated: allPreds.length };
}

/** Kept for backward compatibility with any existing caller — reports whether ANY key is
 * available, backed by the new rotation system rather than a single stored key. */
export async function getOddsApiKeyStatus(): Promise<{ hasKey: boolean; source: "db" | "env" | "none" }> {
  const status = await getOddsApiKeysStatus();
  if (status.availableKeys > 0) return { hasKey: true, source: "db" };
  if (process.env.ODDS_API_KEY) return { hasKey: true, source: "env" };
  return { hasKey: false, source: "none" };
}

/** Kept for backward compatibility — sets a single key. For the multi-key rotation this
 * module now supports, use setOddsApiKeys([...]) instead. */
export async function setOddsApiKey(key: string): Promise<void> {
  await setOddsApiKeys([key]);
}

export { DEFAULT_SPORT_KEYS };
