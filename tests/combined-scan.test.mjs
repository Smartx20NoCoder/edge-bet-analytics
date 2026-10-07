import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const modules={
 '@/lib/admin-auth.server':`export async function requireAdmin(token){if(token!=='test-admin-token-valid')throw new Error('unauthorized')}`,
 '@tanstack/react-router':`export const createFileRoute=()=>x=>x;`,
 '@/integrations/supabase/client.server':`export const supabaseAdmin={};`,
 '@/lib/goaloo-analysis':`export const matchSavedResult=()=>null;`,
 '@/lib/goaloo.server':`export const setForcedKey=()=>{};export const hasMainOdds=()=>true;export const fetchLiveOdds=()=>{};export const fetchMatchAnalysis=()=>{};export async function fetchScheduleByDate(){globalThis.scanOrder.push('goaloo');return []}`,
 '@/lib/predictions.server':`export const gradePrediction=()=>{};export const predictCorners=()=>[];export const predictMatchOutcomes=()=>[];export const meetsConfidenceThreshold=()=>true;`,
 '@/lib/predictions.functions':`export async function lockDailyBestPickIfNeeded(){globalThis.scanOrder.push('select')}`,
 '@/lib/oddsapi.server':`export async function getOddsApiKeysStatus(){return {availableKeys:1}};export async function runDualFreeScan(opts){globalThis.scanOrder.push('odds');if(globalThis.failOdds)throw new Error('fixture source unavailable');opts.onEvent('done',{matchesAnalyzed:5,predictionsGenerated:2});return {matchesAnalyzed:5,predictionsGenerated:2}}`,
};
registerHooks({resolve(s,c,next){if(modules[s])return {url:'data:text/javascript,'+encodeURIComponent(modules[s]),shortCircuit:true};return next(s,c)}});
const {Route}=await import('../src/routes/api/analyze-stream.ts');
globalThis.scanOrder=[];
const denied=await Route.server.handlers.GET({request:new Request('https://example.test/api/analyze-stream')});
assert.equal(denied.status,401);assert.deepEqual(globalThis.scanOrder,[]);
for(const failOdds of [false,true]){
 globalThis.scanOrder=[];globalThis.failOdds=failOdds;
 const response=await Route.server.handlers.GET({request:new Request('https://example.test/api/analyze-stream?date=2099-10-07&engine=combined',{headers:{authorization:'Bearer test-admin-token-valid'}})});
 const events=(await response.text()).trim().split('\n').map(JSON.parse);
 assert.deepEqual(globalThis.scanOrder,['goaloo','odds','select']);
 assert.equal(events.filter(e=>e.event==='done').length,1);
 assert.equal(events.at(-1).event,'done');
 assert.equal(events.at(-1).predictionsGenerated,failOdds?0:2);
 assert.equal(events.at(-1).matchesAnalyzed,failOdds?0:5);
 assert.equal(events.at(-1).failures.length,failOdds?1:0);
}
console.log('Combined route runs both phases before daily selection and emits one final completion, including partial failure');
