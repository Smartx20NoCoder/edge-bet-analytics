import { clean } from './goaloo-parser';

function history(html: string, section: number, cutoff: number) {
  const rows: string[][] = [];
  for (const m of html.matchAll(new RegExp('<tr\\b[^>]*id="tr'+section+'_\\d+"[^>]*>[\\s\\S]*?<\\/tr>', 'gi'))) {
    const row = m[0];
    const scores = row.match(/\binfo="(\d+),(\d+),/);
    const date = row.match(/data-t='([^']+)'/)?.[1];
    const t = date ? Date.parse(date.replace(' ', 'T')+'Z') : NaN;
    const teams = [...row.matchAll(/soccerDbPage\.team\((\d+)\)([\s\S]*?)<\/a>/g)];
    if (!scores || teams.length !== 2 || !Number.isFinite(t) || t >= cutoff || t >= Date.now()) continue;
    const corners = row.match(/class=["']fcorner_\d+["'][^>]*>\s*(\d+)\s*-\s*(\d+)/);
    const r = Array(16).fill('');
    r[0] = row.match(/\bindex="(\d+)"/)?.[1] ?? '';
    r[1] = row.match(/<td[^>]*title="([^"]+)"/)?.[1] ?? '';
    r[3] = String(Math.floor(t/1000));
    r[4] = clean(teams[0][2]); r[5] = teams[0][1];
    r[6] = clean(teams[1][2]); r[7] = teams[1][1];
    r[8] = scores[1]; r[9] = scores[2];
    if (corners) { r[14] = corners[1]; r[15] = corners[2]; }
    rows.push(r);
  }
  return rows;
}

function standings(html: string, side: 'home' | 'guest') {
  const table = html.match(new RegExp('<table\\b[^>]*class=["\']team-table-'+side+'["\'][^>]*>([\\s\\S]*?)<\\/table>', 'i'))?.[1];
  if (!table) return undefined;
  // Only the FT section: never interpret half-time standings as full-time form.
  const ft = table.split(/<th\b[^>]*class=['"]ht-desc['"]/i)[0];
  const out: Record<string, any> = {};
  for (const m of ft.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(x=>clean(x[1]));
    const scope = ({ Total:'total', 'Home Field':'home', 'Away Field':'away' } as Record<string,string>)[cells[0]];
    if (!scope || cells.length < 9 || cells.slice(1,7).some(x=>!/^\d+$/.test(x))) continue;
    const [count,win,draw,lose,scored,conceded] = cells.slice(1,7).map(Number);
    if (count !== win+draw+lose) continue;
    out[scope] = {count,win,draw,lose,scored,conceded,rank:cells[8]};
  }
  return Object.keys(out).length ? out : undefined;
}

export function parseGoalooAnalysis(html: string, expectedId: string) {
  if (html.match(/var\s+scheduleId\s*=\s*(\d+)/)?.[1] !== expectedId) throw new Error('Goaloo returned a different match.');
  const ld = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m=>{try{return JSON.parse(m[1]);}catch{return null;}}).find(x=>x?.['@type']==='SportsEvent');
  const kickoff = Date.parse(ld?.startDate);
  const state = Number(html.match(/\bstate:\s*parseInt\('(-?\d+)'\)/)?.[1]);
  const homeId = html.match(/var h2h_home\s*=\s*(\d+)/)?.[1];
  const awayId = html.match(/var h2h_away\s*=\s*(\d+)/)?.[1];
  if (!homeId || !awayId || !Number.isFinite(kickoff) || state !== 0 || kickoff <= Date.now()) throw new Error('Match is already started or its kickoff/status could not be verified.');
  return {data:{
    homeLastMatches:history(html,1,kickoff), awayLastMatches:history(html,2,kickoff), headToHead:history(html,3,kickoff),
    homeDataVs:standings(html,'home'), awayDataVs:standings(html,'guest'),
  }, source:'goaloo', homeId, awayId, kickoff:new Date(kickoff).toISOString()};
}

export function matchSavedResult(prediction: any, results: any[]) {
  const id = String(prediction.match_id);
  if (id.startsWith('goaloo:')) return results.find(r=>r.matchId===id);
  // Legacy provider IDs are never assumed to be Goaloo IDs. Match both teams and exact kickoff.
  const name = (s: string) => String(s??'').normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
  const candidates = results.filter(r=>name(r.homeName)===name(prediction.home_team) && name(r.awayName)===name(prediction.away_team) && Math.abs(Date.parse(r.kickoff)-Date.parse(prediction.kickoff))<60000);
  return candidates.length===1 ? candidates[0] : undefined;
}
