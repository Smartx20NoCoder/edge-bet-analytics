import { supabaseAdmin } from '@/integrations/supabase/client.server';
import { readPublic, parseSchedule } from './goaloo-parser';
import {awardedMatchNotice,verifiedGoalooStatus,goalooVoidStatus} from './goaloo-result-policy';
import {matchSavedResult} from './goaloo-analysis';
import { parseGoalooAnalysis } from './goaloo-analysis';
import { collectGoalooOdds } from './goaloo-odds';
import type { ScheduleMatch, LiveOdds, ResultRow } from './isports.server';

async function cached<T>(key: string, seconds: number, fetcher: ()=>Promise<T>, refresh=false): Promise<T> {
  if (!refresh) {
    const {data} = await supabaseAdmin.from('analysis_cache').select('raw,fetched_at').eq('match_id',key).maybeSingle();
    if (data && Date.now()-Date.parse(data.fetched_at)<seconds*1000) return data.raw as T;
  }
  const value = await fetcher();
  const {error} = await supabaseAdmin.from('analysis_cache').upsert({match_id:key,raw:JSON.parse(JSON.stringify(value)),fetched_at:new Date().toISOString()});
  if (error) console.warn('[Goaloo] Cache write failed:',error.message);
  return value;
}
function validateDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date+'T00:00:00Z')) || new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date) throw new Error('Invalid fixture date.');
}
function idOf(id: string) {
  if (!/^goaloo:\d+$/.test(id)) throw new Error('Expected a Goaloo fixture ID.');
  return id.slice(7);
}
async function schedule(date: string, ttl=300) {
  validateDate(date);
  // Edge Bet's date and stored kickoff contract is UTC; timezone=0 prevents offset shifts.
  return cached(`__goaloo_schedule_${date}`,ttl,async()=>parseSchedule(await readPublic(`https://www.goaloo.com/ajax/SoccerAjax?type=6&date=${date}&order=time&timezone=0`)));
}
export async function fetchScheduleByDate(date: string): Promise<ScheduleMatch[]> {
  return (await schedule(date)).filter(f=>f.state===0).map(f=>({
    matchId:`goaloo:${f.id}`,leagueId:f.leagueId,leagueName:f.league,homeId:f.homeId,awayId:f.awayId,
    homeName:f.home,awayName:f.away,matchTime:Date.parse(f.kickoff)/1000,
    raw:{source:'goaloo',url:f.url,homeRank:f.raw[16],awayRank:f.raw[17],state:f.state},
  }));
}
export async function fetchMatchAnalysis(matchId: string, refresh=false) {
  const id=idOf(matchId);
  const result=await cached(`__goaloo_analysis_${id}`,6*3600,async()=>parseGoalooAnalysis(await readPublic(`https://www.goaloo.com/football/match/h2h-${id}`),id),refresh);
  if (Date.parse(result.kickoff)<=Date.now()) throw new Error('Match has already started.');
  return result;
}
const median=(values:number[])=>{const a=[...values].sort((x,y)=>x-y),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2;};
export async function fetchLiveOdds(matchId: string): Promise<LiveOdds> {
  const id=idOf(matchId);
  return cached(`__goaloo_odds_${id}`,300,async()=>{
    const {quotes}=await collectGoalooOdds(id);
    const values=(market:string)=>quotes.filter(q=>q.market===market).map(q=>q.odds);
    const result:LiveOdds={};
    const h=values('home'),d=values('draw'),a=values('away');
    if(h.length>=2&&d.length>=2&&a.length>=2) result.matchWinner={oH:median(h),oD:median(d),oA:median(a),bookmakers:Math.min(h.length,d.length,a.length)};
    const over=values('total-over-2.5'),under=values('total-under-2.5');
    if(over.length>=2&&under.length>=2) result.goals25={oOver:median(over),oUnder:median(under),bookmakers:Math.min(over.length,under.length)};
    for(const [market,key] of [['ah:home:0.5','ahHomePlus'],['ah:away:0.5','ahAwayPlus']] as const){const v=values(market);if(v.length>=2)result[key]={odds:median(v),bookmakers:v.length};}
    return result;
  });
}
export async function hasMainOdds(id: string) {
  const odds=await fetchLiveOdds(id);
  return !!(odds.matchWinner||odds.goals25);
}
export type GoalooResult=ResultRow & {homeName:string;awayName:string;kickoff:string;awardReason?:string};
export async function fetchResultsByDate(date: string,predictions?:any[]): Promise<GoalooResult[]> {
 const rows=(await schedule(date,60)).filter(f=>f.state<0||awardedMatchNotice(f.raw[19])||awardedMatchNotice(f.raw[21])).map(f=>{
  const reason=awardedMatchNotice(f.raw[19])??awardedMatchNotice(f.raw[21]);
  const voidStatus=reason?'AWARDED':goalooVoidStatus(f.state);
  const pending=!voidStatus&&f.state!==-1;
  return {matchId:`goaloo:${f.id}`,homeName:f.home,awayName:f.away,kickoff:f.kickoff,
   homeScore:(!pending&&(!voidStatus||reason))&&Number.isInteger(f.raw[8])?f.raw[8]:null,awayScore:(!pending&&(!voidStatus||reason))&&Number.isInteger(f.raw[9])?f.raw[9]:null,
   homeCorners:!pending&&!voidStatus&&Number.isInteger(f.raw[23])&&Number.isInteger(f.raw[24])&&f.raw[23]+f.raw[24]>0?f.raw[23]:null,
   awayCorners:!pending&&!voidStatus&&Number.isInteger(f.raw[23])&&Number.isInteger(f.raw[24])&&f.raw[23]+f.raw[24]>0?f.raw[24]:null,
   status:voidStatus??(pending?'PENDING':'FT'),...(reason?{awardReason:reason}:{})} as GoalooResult;
 }).filter(r=>r.status!=='FT'||r.homeScore!==null&&r.awayScore!==null);
 if(!predictions)return rows.filter(r=>r.status!=='PENDING');
 // Verify only saved matches, not every game on the day's schedule. One cached
 // page check covers all markets and both model sources for the same fixture.
 const selected=rows.filter(r=>predictions.some(p=>matchSavedResult(p,[r]))),verified:GoalooResult[]=[];let cursor=0;
 await Promise.all(Array.from({length:Math.min(4,selected.length)},async()=>{while(cursor<selected.length){const r=selected[cursor++];try{
  if(r.status!=='FT'&&r.status!=='PENDING'){verified.push(r);continue;}
  const id=idOf(r.matchId),status=await cached(`__goaloo_result_status_v2_${id}`,3600,async()=>verifiedGoalooStatus(await readPublic(`https://www.goaloo.com/football/match/live-${id}`),id));
  if(status.awarded)verified.push({...r,status:'AWARDED',awardReason:status.reason,homeCorners:null,awayCorners:null});else if(status.voided)verified.push({...r,status:status.status!,homeScore:null,awayScore:null,homeCorners:null,awayCorners:null});else if(status.state===-1)verified.push(r);
 }catch(e){console.warn('[Goaloo] Result status could not be verified; match left ungraded:',r.matchId,e instanceof Error?e.message:'Source unavailable');}}}));
 return verified;
}
// Kept as a compatibility shim for older callers; Goaloo requires no API key.
export function setForcedKey(_idx:1|2|null) {}
