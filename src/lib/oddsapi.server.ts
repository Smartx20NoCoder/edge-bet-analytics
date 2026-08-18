// Server-only The Odds API (v4) client. Never import from client code.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const BASE = "https://api.the-odds-api.com/v4";

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function getApiKey(): Promise<string | undefined> {
  const { data } = await supabaseAdmin.from("engine_settings").select("odds_api_key").eq("id", true).maybeSingle();
  return (data?.odds_api_key as string | undefined) || process.env.ODDS_API_KEY || undefined;
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
  const key = await getApiKey();
  if (!key) throw new Error("ODDS_API_KEY is not configured.");
  const url = `${BASE}/sports/${sportKey}/odds?apiKey=${key}&regions=eu,uk,us&markets=${markets}&oddsFormat=decimal`;
  const res = await fetch(url);
  const text = await res.text();
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
      events = await getEventsPayload(sportKey, "h2h,spreads,totals");
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
  prediction_type: "match_winner" | "over_2_5_goals" | "match_winner_hedged";
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
  thresholds: { matchWinnerFloor?: number; over25Floor?: number } = {},
): OddsApiPrediction[] {
  const matchWinnerFloor = thresholds.matchWinnerFloor ?? 49;
  const over25Floor = thresholds.over25Floor ?? 55;
  const bookmakers: any[] = Array.isArray(event?.bookmakers) ? event.bookmakers : [];
  const pinnacle = bookmakers.find((b) => b.key === SHARP_BOOK_KEY);
  if (!pinnacle) return [];
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
            `Consensus of ${fv.otherBookCount} other bookmaker(s): ${fv.otherOdds.toFixed(2)} odds for ${selection}.`,
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

  const pinTotals = (pinnacle.markets ?? []).find((m: any) => m.key === "totals");
  if (pinTotals) {
    const overOut = (pinTotals.outcomes ?? []).find((o: any) => o.name === "Over" && Math.abs(Number(o.point) - 2.5) < 0.001);
    const underOut = (pinTotals.outcomes ?? []).find((o: any) => o.name === "Under" && Math.abs(Number(o.point) - 2.5) < 0.001);
    const pinOver = Number(overOut?.price), pinUnder = Number(underOut?.price);
    if (pinOver >= 1.01 && pinUnder >= 1.01) {
      const iO = 1 / pinOver, iU = 1 / pinUnder;
      const fairOver = iO / (iO + iU);
      const otherOver: number[] = [];
      for (const bm of bookmakers) {
        if (bm.key === SHARP_BOOK_KEY) continue;
        const mkt = (bm.markets ?? []).find((m: any) => m.key === "totals");
        const o = (mkt?.outcomes ?? []).find((x: any) => x.name === "Over" && Math.abs(Number(x.point) - 2.5) < 0.001);
        const price = Number(o?.price);
        if (price >= 1.01) otherOver.push(price);
      }
      const confidence = Math.round(fairOver * 1000) / 10;
      if (otherOver.length >= 2 && confidence >= over25Floor) {
        const consensusOdds = median(otherOver);
        const ev = Math.round((fairOver * consensusOdds - 1) * 10000) / 10000;
        out.push({
          prediction_type: "over_2_5_goals",
          selection: "Over 2.5 Goals",
          confidence,
          market_odds: consensusOdds,
          model_probability: fairOver,
          expected_value: ev,
          reasons: [
            `Pinnacle fair value @ 2.5 line: Over ${(fairOver*100).toFixed(0)}% (from ${pinOver.toFixed(2)}/${pinUnder.toFixed(2)} odds).`,
            `Consensus of ${otherOver.length} other bookmaker(s): ${consensusOdds.toFixed(2)} odds for Over 2.5.`,
            `EV = (${(fairOver*100).toFixed(1)}% Pinnacle-fair prob × ${consensusOdds.toFixed(2)} consensus odds) − 1 = ${(ev*100).toFixed(1)}%.`,
            "Line-shopping strategy (sharp vs soft), not an independent stats-based prediction.",
          ],
          stats: { engine: "oddsapi_sharp_fair_value", fairOver, pinnacleOdds: { pinOver, pinUnder } },
        });
      }
    }
  }
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
    const key = await getApiKey();
    if (!key) throw new Error("ODDS_API_KEY is not configured.");
    const url = `${BASE}/sports/${sportKey}/scores?apiKey=${key}&daysFrom=${daysFrom}&dateFormat=iso`;
    const res = await fetch(url);
    const text = await res.text();
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

const DEFAULT_SPORT_KEYS = [
  "soccer_epl", "soccer_spain_la_liga", "soccer_italy_serie_a", "soccer_germany_bundesliga",
  "soccer_france_ligue_one", "soccer_netherlands_eredivisie", "soccer_portugal_primeira_liga",
  "soccer_usa_mls", "soccer_brazil_campeonato", "soccer_argentina_primera_division",
  "soccer_efl_champ", "soccer_uefa_champs_league_qualification",
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
        over25Floor: opts.over25Floor,
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

export async function getOddsApiKeyStatus(): Promise<{ hasKey: boolean; source: "db" | "env" | "none" }> {
  const { data } = await supabaseAdmin.from("engine_settings").select("odds_api_key").eq("id", true).maybeSingle();
  if (data?.odds_api_key) return { hasKey: true, source: "db" };
  if (process.env.ODDS_API_KEY) return { hasKey: true, source: "env" };
  return { hasKey: false, source: "none" };
}

export async function setOddsApiKey(key: string): Promise<void> {
  await supabaseAdmin.from("engine_settings").upsert({ id: true, odds_api_key: key.trim() || null, updated_at: new Date().toISOString() });
}

export { DEFAULT_SPORT_KEYS };
