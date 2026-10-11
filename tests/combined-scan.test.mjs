import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const modules={
 '@/lib/scan-automation':new URL('../src/lib/scan-automation.ts',import.meta.url).href,
 '@/lib/analyze-stream.server':new URL('../src/lib/analyze-stream.server.ts',import.meta.url).href,
 '@/lib/cron-auth.server':`export const isCronAuthorized=()=>false;`,
 '@/lib/admin-auth.server':`export async function requireAdmin(token){if(token!=='test-admin-token-valid')throw new Error('unauthorized')}`,
 '@tanstack/react-router':`export const createFileRoute=()=>x=>x;`,
 '@/integrations/supabase/client.server':`export const supabaseAdmin={from(table){return {select(){return this},gte(){return this},lte(){return this},order(){return this},range(){return Promise.resolve({data:[],error:null})},upsert(){return Promise.resolve({error:null})},insert(rows){globalThis.savedRows??=[];globalThis.savedRows.push({table,rows});return this},single(){return Promise.resolve(globalThis.failSave?{data:null,error:{message:'Database unavailable'}}:{data:{id:'analysis'},error:null})},then(resolve){resolve({error:null})}}}};`,
 '@/lib/goaloo-analysis':`export const matchSavedResult=()=>null;`,
 '@/lib/goaloo.server':`export const setForcedKey=()=>{};export const hasMainOdds=()=>true;export async function fetchLiveOdds(id){globalThis.oddsCalls??={};globalThis.oddsCalls[id]=(globalThis.oddsCalls[id]??0)+1;if(globalThis.oddsErrors?.includes(id)||globalThis.oddsErrorOnce===id&&globalThis.oddsCalls[id]===1)throw new Error('Source timed out');return globalThis.testOdds?.[id]??{matchWinner:{oH:1.8,oD:3,oA:4,bookmakers:2}}};export async function fetchMatchAnalysis(id){if(globalThis.analysisErrors?.includes(id))throw new Error('Analysis timed out');return {}};export async function fetchScheduleByDate(){globalThis.scanOrder.push('goaloo');return globalThis.testFixtures??[]}`,
 '@/lib/predictions.server':`export const gradePrediction=()=>{};export const predictCorners=()=>[];export const predictMatchOutcomes=()=>globalThis.testPredictions??[];export const meetsConfidenceThreshold=()=>true;`,
 '@/lib/predictions.functions':`export async function lockDailyBestPickIfNeeded(){globalThis.scanOrder.push('select')}`,
 '@/lib/oddsapi.server':`export async function getOddsApiKeysStatus(){return {availableKeys:globalThis.noOddsKeys?0:1}};export async function runDualFreeScan(opts){globalThis.scanLimit=opts.maxMatches;globalThis.scanOrder.push('odds');if(globalThis.failOdds)throw new Error('fixture source unavailable');opts.onEvent('done',{matchesAnalyzed:5,predictionsGenerated:2});return {matchesAnalyzed:5,predictionsGenerated:2}}`,
};
registerHooks({resolve(s,c,next){if(modules[s])return {url:modules[s].startsWith('file:')?modules[s]:'data:text/javascript,'+encodeURIComponent(modules[s]),shortCircuit:true};return next(s,c)}});
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
 assert.equal(events.at(-1).event,'done');assert.equal(globalThis.scanLimit,500);
 assert.equal(events.at(-1).predictionsGenerated,failOdds?0:2);
 assert.equal(events.at(-1).matchesAnalyzed,failOdds?0:5);
 assert.equal(events.at(-1).failures.length,failOdds?1:0);
}
console.log('Combined route runs both phases before daily selection and emits one final completion, including partial failure');

for(const limit of [1,357,500]){const response=await Route.server.handlers.GET({request:new Request('https://example.test/api/analyze-stream?date=2099-10-07&engine=dual_free&maxMatches='+limit,{headers:{authorization:'Bearer test-admin-token-valid'}})});await response.text();assert.equal(globalThis.scanLimit,limit);}
for(const limit of ['0','501','1.5','bad']){const response=await Route.server.handlers.GET({request:new Request('https://example.test/api/analyze-stream?maxMatches='+limit,{headers:{authorization:'Bearer test-admin-token-valid'}})});assert.equal(response.status,400);}
console.log('Real scan route passes custom limits through to Odds API up to 500 and rejects invalid limits.');

globalThis.scanOrder=[];globalThis.noOddsKeys=true;globalThis.failOdds=false;
const unavailable=await Route.server.handlers.GET({request:new Request('https://example.test/api/analyze-stream?date=2099-10-07&engine=combined',{headers:{authorization:'Bearer test-admin-token-valid'}})});
const final=(await unavailable.text()).trim().split('\n').map(JSON.parse).at(-1);
assert.deepEqual(globalThis.scanOrder,['goaloo','select']);assert.deepEqual(final.completedSources,['Goaloo']);assert.deepEqual(final.failures,['Odds API unavailable']);
console.log('Unavailable Odds API retains a completed Goaloo phase and still selects fixed daily picks.');

const {handleAnalyzeStream}=await import('../src/lib/analyze-stream.server.ts');
globalThis.testFixtures=Array.from({length:530},(_,i)=>({matchId:'goaloo:'+i,leagueName:'England Premier League',homeName:'Home '+i,awayName:'Away '+i,matchTime:Date.parse('2099-10-07T12:00:00Z')/1000,raw:{}}));
globalThis.noOddsKeys=false;
let processedIds=[],analysed=0,batches=0,phase='goaloo';
do {
 globalThis.scanOrder=[];
 const batchResponse=await handleAnalyzeStream(new Request('https://example.test/api/analyze-stream?date=2099-10-07&engine=combined&trustedOnly=false&maxMatches=500',{headers:{authorization:'Bearer test-admin-token-valid'}}),{processedIds,remaining:500-analysed,phase});
 const batch=(await batchResponse.text()).trim().split('\n').map(JSON.parse).at(-1);
 assert.equal(batch.event,'done');analysed+=batch.goalooBatch.matchesAnalyzed;processedIds.push(...batch.goalooBatch.processedIds);batches++;
 assert.equal(new Set(processedIds).size,processedIds.length);
 phase=batch.oddsApiPending?'odds':'goaloo';
 if(batch.goalooBatch.pending||batch.oddsApiPending){assert(!globalThis.scanOrder.includes('select'));assert(!globalThis.scanOrder.includes('odds'));}else {assert(globalThis.scanOrder.includes('select'));break;}
 assert(batches<20,'Batch scan did not finish');
}while(true);
assert.equal(analysed,500);assert.equal(processedIds.length,500);assert.equal(batches,10);
console.log('Automatic scan reaches 500 matches across nine Goaloo batches plus a separate Odds API phase without duplicates or early daily-pick selection.');

const fixtures=count=>Array.from({length:count},(_,i)=>({matchId:'goaloo:'+i,leagueName:'England Premier League',homeName:'Home '+i,awayName:'Away '+i,matchTime:Date.parse('2099-10-07T12:00:00Z')/1000,raw:{}}));
async function goalooBatch(remaining,processedIds=[],retryCounts={}){
 globalThis.scanOrder=[];
 const response=await handleAnalyzeStream(new Request('https://example.test/api/analyze-stream?date=2099-10-07&engine=goaloo&trustedOnly=false&maxMatches=500&minOdds=1.5&maxOdds=2.3',{headers:{authorization:'Bearer test-admin-token-valid'}}),{remaining,processedIds,retryCounts});
 return (await response.text()).trim().split('\n').map(JSON.parse).at(-1);
}
globalThis.testFixtures=fixtures(400);globalThis.testOdds={};globalThis.noOddsKeys=true;
let successful=0,cursor=[];
do{
 const result=await goalooBatch(500-successful,cursor);successful+=result.matchesAnalyzed;cursor.push(...result.goalooBatch.processedIds);
 if(!result.goalooBatch.pending){assert.equal(result.goalooBatch.stopReason,'exhausted');break;}
 assert(!globalThis.scanOrder.includes('select'));
}while(true);
assert.equal(successful,400);assert.equal(cursor.length,400);
console.log('A pool smaller than 500 finishes after all 400 priceable fixtures, without invented failures.');

globalThis.testFixtures=fixtures(7);globalThis.testOdds={'goaloo:2':{},'goaloo:3':{}};
const short=await goalooBatch(3);
assert.equal(short.matchesAnalyzed,3);assert.equal(short.goalooBatch.skippedNoOdds,2);
assert(short.goalooBatch.processedIds.includes('goaloo:4'),'Partial groups must not skip the next fixture');
assert.equal(short.goalooBatch.stopReason,'limit_reached');

globalThis.testFixtures=fixtures(3);globalThis.testOdds={'goaloo:1':{coverage:{oneXTwo:1,goals25:0}}};globalThis.oddsErrors=['goaloo:0'];
const failed=await goalooBatch(3);
assert.equal(failed.matchesAnalyzed,1);assert.equal(failed.goalooBatch.oddsRequestFailures,1);
assert.equal(failed.goalooBatch.insufficientCoverage,1);assert.equal(failed.goalooBatch.skippedNoOdds,0);
assert(!failed.goalooBatch.processedIds.includes('goaloo:0'));assert(failed.goalooBatch.pending);assert(!globalThis.scanOrder.includes('select'));
globalThis.oddsErrors=[];
const recovered=await goalooBatch(2,failed.goalooBatch.processedIds,failed.goalooBatch.retryCounts);
assert.equal(recovered.matchesAnalyzed,1);assert.equal(recovered.goalooBatch.pending,false);assert(globalThis.scanOrder.includes('select'));

globalThis.testFixtures=fixtures(1);globalThis.testOdds={};globalThis.oddsCalls={};globalThis.oddsErrorOnce='goaloo:0';
const immediateRetry=await goalooBatch(1);
assert.equal(immediateRetry.matchesAnalyzed,1);assert.equal(globalThis.oddsCalls['goaloo:0'],2);assert.equal(immediateRetry.goalooBatch.oddsRequestFailures,0);
globalThis.oddsErrorOnce=null;
globalThis.analysisErrors=['goaloo:0'];
const analysisFailed=await goalooBatch(1);assert.equal(analysisFailed.matchesAnalyzed,0);assert.equal(analysisFailed.goalooBatch.analysisFailures,1);assert(analysisFailed.goalooBatch.pending);
const exhausted=await goalooBatch(1,analysisFailed.goalooBatch.processedIds,analysisFailed.goalooBatch.retryCounts);assert.equal(exhausted.matchesAnalyzed,0);assert.equal(exhausted.goalooBatch.pending,false);assert.equal(exhausted.goalooBatch.stopReason,'exhausted');
globalThis.analysisErrors=[];
console.log('Request errors are retried, distinguished from missing markets/coverage, and do not consume successful-analysis slots.');

globalThis.testFixtures=fixtures(1);globalThis.testPredictions=[{type:'match_winner',selection:'Home Win',confidence:80,modelProbability:.8,stats:{},reasons:[]}];globalThis.savedRows=[];
const priced=await goalooBatch(1);assert.equal(priced.predictionsGenerated,1);assert.equal(priced.positiveEvPicks,1);assert.equal(priced.dailyEligibleMatches,0,'44% EV exceeds the unchanged 40% daily ceiling');
assert.equal(globalThis.savedRows.find(r=>r.table==='predictions').rows[0].market_odds,1.8);
globalThis.testPredictions=[{type:'match_winner',selection:'Home Win',confidence:60,modelProbability:.6,stats:{},reasons:[]}];globalThis.testOdds={'goaloo:0':{matchWinner:{oH:1.2,oD:3,oA:4,bookmakers:2}}};
assert.equal((await goalooBatch(1)).predictionsGenerated,0,'Out-of-range actual prices must be rejected');
globalThis.testPredictions=[];globalThis.testOdds={};globalThis.failSave=true;
assert.equal((await goalooBatch(1)).event,'error');assert(!globalThis.scanOrder.includes('select'));
globalThis.failSave=false;
const deniedPost=await Route.server.handlers.POST({request:new Request('https://example.test/api/analyze-stream',{method:'POST',body:JSON.stringify({processedIds:[],remaining:500})})});assert.equal(deniedPost.status,401);
const invalidPost=await Route.server.handlers.POST({request:new Request('https://example.test/api/analyze-stream',{method:'POST',body:JSON.stringify({processedIds:[],remaining:501})})});assert.equal(invalidPost.status,400);
console.log('Actual-price filtering retains valid value picks, rejects out-of-range prices, and failed saves cannot advance daily selection.');
