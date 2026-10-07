import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const modules={
 '@tanstack/react-start':`export const createServerFn=()=>({inputValidator(){return this},handler(fn){return arg=>fn({data:arg?.data??{}})}});`,
 '@/integrations/supabase/client.server':`export const supabaseAdmin={from(){let id;return {select(){return this},is(){return this},eq(_,v){id=v;return this},update(v){this.row=v;return this},then(resolve){if(this.row){globalThis.writes.push({id,...this.row});resolve({error:globalThis.failWrite?new Error('write failed'):null})}else resolve({data:globalThis.pending,error:null})}}}};`,
 './goaloo.server.ts':`export const fetchScheduleByDate=()=>[];export const fetchLiveOdds=()=>{};export const fetchMatchAnalysis=()=>{};export const setForcedKey=()=>{};export async function fetchResultsByDate(){globalThis.resultCalls.push('goaloo');if(globalThis.failGoaloo)throw new Error('source unavailable');return [{matchId:'goaloo:123',homeScore:2,awayScore:1,status:-1,homeCorners:null,awayCorners:null}]}`,
 './oddsapi.server.ts':`export async function fetchOddsApiResults(){globalThis.resultCalls.push('odds');return [{matchId:'abcdef',homeScore:0,awayScore:1,status:-1}]}`,
 './admin-auth.server.ts':`export const requireAdmin=()=>{};`,
};
registerHooks({resolve(s,c,next){if(s.startsWith('./')&&!/\.(?:ts|js|mjs)$/.test(s))s+='.ts';if(modules[s])return {url:'data:text/javascript,'+encodeURIComponent(modules[s]),shortCircuit:true};return next(s,c)}});
const {updateAllPendingResults}=await import('../src/lib/predictions.functions.ts');
for(const [failGoaloo,failWrite] of [[false,false],[true,false],[false,true]]){
 Object.assign(globalThis,{failGoaloo,failWrite,writes:[],resultCalls:[],pending:[
  {id:'one',match_id:'goaloo:123',kickoff:'2026-10-06T12:00Z',prediction_type:'match_winner',selection:'Home Win'},
  {id:'two',match_id:'abcdef',league_id:'soccer_epl',kickoff:'2026-10-06T12:00Z',prediction_type:'match_winner',selection:'Away Win'},
 ]});
 const result=await updateAllPendingResults({data:{}});
 assert.deepEqual(globalThis.resultCalls,['goaloo','odds']);
 assert.equal(result.updated,failWrite?0:failGoaloo?1:2);
 assert.equal(result.stillPending,failWrite?2:failGoaloo?1:0);
 if(!failGoaloo&&!failWrite)assert.deepEqual(globalThis.writes.map(x=>x.is_correct),[true,true]);
}
console.log('Shared button/cron updater grades both sources, continues after source failure, and does not count failed writes');
