import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const modules={
 '@tanstack/react-start':`export const createServerFn=()=>({inputValidator(){return this},handler(fn){return arg=>fn({data:arg?.data??{}})}});`,
 '@/integrations/supabase/client.server':`export const supabaseAdmin={from(){let id;return {select(){return this},async single(){return {data:globalThis.manualRow,error:null}},is(){return this},gte(_,v){globalThis.resultFrom=v;return this},lte(_,v){globalThis.resultUntil=v;return this},eq(_,v){id=v;return this},in(_,v){id=v;return this},update(v){this.row=v;return this},then(resolve){if(this.row){globalThis.writes.push({id,...this.row});resolve({error:globalThis.failWrite?new Error('write failed'):null})}else resolve({data:globalThis.pending,error:null})}}}};`,
 './goaloo.server.ts':`export const fetchScheduleByDate=()=>[];export const fetchLiveOdds=()=>{};export const fetchMatchAnalysis=()=>{};export const setForcedKey=()=>{};export async function fetchResultsByDate(){globalThis.resultCalls.push('goaloo');if(globalThis.failGoaloo)throw new Error('source unavailable');if(globalThis.award)return [{matchId:'goaloo:123',homeName:'Home',awayName:'Away',kickoff:'2026-10-06T12:00Z',homeScore:globalThis.voidResultStatus?null:3,awayScore:globalThis.voidResultStatus?null:0,status:globalThis.voidResultStatus??'AWARDED',homeCorners:null,awayCorners:null}];return [{matchId:'goaloo:123',homeScore:2,awayScore:1,status:-1,homeCorners:null,awayCorners:null}]}`,
 './oddsapi.server.ts':`export async function fetchOddsApiResults(){globalThis.resultCalls.push('odds');return [{matchId:'abcdef',homeScore:0,awayScore:1,status:-1}]}`,
 './admin-auth.server.ts':`export const requireAdmin=(token)=>{if(token!=='test-admin-token-valid')throw new Error('unauthorized')};`,
};
registerHooks({resolve(s,c,next){if(s.startsWith('./')&&!/\.(?:ts|js|mjs)$/.test(s))s+='.ts';if(modules[s])return {url:'data:text/javascript,'+encodeURIComponent(modules[s]),shortCircuit:true};return next(s,c)}});
const {updateAllPendingResults,updateAllPendingResultsInternal}=await import('../src/lib/predictions.functions.ts');
await assert.rejects(()=>updateAllPendingResults({data:{}}),/unauthorized/);
for(const [failGoaloo,failWrite] of [[false,false],[true,false],[false,true]]){
 Object.assign(globalThis,{failGoaloo,failWrite,writes:[],resultCalls:[],pending:[
  {id:'one',match_id:'goaloo:123',kickoff:'2026-10-06T12:00Z',prediction_type:'match_winner',selection:'Home Win'},
  {id:'two',match_id:'abcdef',league_id:'soccer_epl',kickoff:'2026-10-06T12:00Z',prediction_type:'match_winner',selection:'Away Win'},
 ]});
 const result=await updateAllPendingResults({data:{accessToken:'test-admin-token-valid'}});
 assert.deepEqual(globalThis.resultCalls,['goaloo','odds']);
 assert.equal(result.updated,failWrite?0:failGoaloo?1:2);
 assert.equal(result.stillPending,failWrite?2:failGoaloo?1:0);
 if(!failGoaloo&&!failWrite)assert.deepEqual(globalThis.writes.map(x=>x.is_correct),[true,true]);
}
console.log('Shared button/cron updater grades both sources, continues after source failure, and does not count failed writes');

Object.assign(globalThis,{award:true,failGoaloo:false,failWrite:false,writes:[],resultCalls:[],pending:[{id:'one',match_id:'goaloo:123',kickoff:'2026-10-06T12:00Z',prediction_type:'match_winner',selection:'Home Win'},{id:'two',match_id:'abcdef',league_id:'soccer_epl',home_team:'Home',away_team:'Away',kickoff:'2026-10-06T12:00Z',prediction_type:'match_winner',selection:'Away Win'}]});
assert.equal((await updateAllPendingResultsInternal()).updated,2);
assert.deepEqual(globalThis.writes.map(x=>[x.ft_status,x.is_correct]),[['AWARDED',null],['AWARDED',null]]);
globalThis.writes=[];globalThis.pending=globalThis.pending.map(p=>({...p,ft_status:'AWARDED'}));assert.equal((await updateAllPendingResultsInternal()).updated,0);assert.equal(globalThis.writes.length,0);
const {gradePrediction}=await import('../src/lib/predictions.server.ts');for(const type of ['match_winner','over_2_5_goals','btts','double_chance','over_8_5_corners'])assert.equal(gradePrediction(type,'Home Win',{homeScore:3,awayScore:0,homeCorners:6,awayCorners:5,status:'AWARDED'}),null);
console.log('Award notice overrides both model sources, every market is ungraded, and saved awards are not overwritten.');

const {markPredictionAwarded}=await import('../src/lib/predictions.functions.ts');const id='00000000-0000-4000-8000-000000000001';await assert.rejects(()=>markPredictionAwarded({data:{predictionId:id,accessToken:'unauthorized-token-long'}}),/unauthorized/);globalThis.manualRow={match_id:'goaloo:123',kickoff:'2099-01-01T00:00Z'};await assert.rejects(()=>markPredictionAwarded({data:{predictionId:id,accessToken:'test-admin-token-valid'}}),/after kickoff/);globalThis.manualRow.kickoff='2026-01-01T00:00Z';globalThis.manualRow.home_team='Home';globalThis.manualRow.away_team='Away';globalThis.pending=[{id:'other-engine',match_id:'abcdef',kickoff:globalThis.manualRow.kickoff,home_team:'Home',away_team:'Away'},{id:'different-game',match_id:'different',kickoff:globalThis.manualRow.kickoff,home_team:'Other',away_team:'Away'}];globalThis.writes=[];await markPredictionAwarded({data:{predictionId:id,accessToken:'test-admin-token-valid'}});assert.equal(globalThis.writes[0].ft_status,'AWARDED');assert.equal(globalThis.writes[0].is_correct,null);
console.log('Admin-only award fallback rejects future matches and neutralizes all selections for its fixture.');
assert.deepEqual(globalThis.writes[0].id,[id,'other-engine']);

for(const status of ['POSTPONED','CANCELLED','ABANDONED']){
 Object.assign(globalThis,{award:true,voidResultStatus:status,failGoaloo:false,failWrite:false,writes:[],resultCalls:[],pending:[{id:'one',match_id:'goaloo:123',kickoff:'2026-10-06T12:00Z',prediction_type:'match_winner',selection:'Home Win'},{id:'two',match_id:'abcdef',league_id:'soccer_epl',home_team:'Home',away_team:'Away',kickoff:'2026-10-06T12:00Z',prediction_type:'match_winner',selection:'Away Win'}]});
 assert.equal((await updateAllPendingResultsInternal()).updated,2);assert.ok(globalThis.writes.every(p=>p.ft_status===status&&p.is_correct===null&&p.home_score===null));
 globalThis.pending=globalThis.pending.map(p=>({...p,ft_status:status}));assert.equal((await updateAllPendingResultsInternal()).stillPending,0);
}
console.log('Confirmed unplayed void results settle both sources without scores and stay out of the pending queue.');

Object.assign(globalThis,{pending:[],writes:[],award:false,resultFrom:null,resultUntil:null});
const before=Date.now();await updateAllPendingResultsInternal(undefined,{automatic:true});const after=Date.now();
assert.ok(Date.parse(globalThis.resultFrom)>=before-7*86400000&&Date.parse(globalThis.resultFrom)<=after-7*86400000);
assert.ok(Date.parse(globalThis.resultUntil)>=before-110*60000&&Date.parse(globalThis.resultUntil)<=after-110*60000);
console.log('Automatic checks bound the recent backlog and wait 110 minutes after kickoff.');
