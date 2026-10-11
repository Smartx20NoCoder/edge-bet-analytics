import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
let saved=[],calls=0;
const existing=Array.from({length:100},(_,i)=>({match_id:'fixture-'+i}));
globalThis.coverageDB={from(table){let rows;return {select(){return this},eq(){return this},gte(){return this},lte(){return this},order(){return this},async range(start,end){return {data:existing.slice(start,end+1),error:null}},async maybeSingle(){return {data:table==='engine_settings'?{odds_api_keys:[{key:'test-key',exhausted_at:null}]}:null,error:null}},async upsert(){return {error:null}},insert(value){rows=value;if(table==='predictions')saved=value;return this},async single(){return {data:{id:'analysis'},error:null}},then(resolve){resolve({error:null})}}}};
registerHooks({resolve(s,c,next){
 if(s==='@/integrations/supabase/client.server')return {url:'data:text/javascript,export const supabaseAdmin=globalThis.coverageDB',shortCircuit:true};
 if(s==='./predictions.functions')return {url:'data:text/javascript,export async function lockDailyBestPickIfNeeded(){throw new Error("Daily selection must be deferred")}',shortCircuit:true};
 return next(s,c);
}});
const {runDualFreeScan,fetchOddsApiFixtures}=await import('../src/lib/oddsapi.server.ts');
const event=i=>({id:'fixture-'+i,sport_key:'soccer_test',sport_title:'Test League',home_team:'Home '+i,away_team:'Away '+i,commence_time:'2099-10-07T12:00:00Z',bookmakers:['pinnacle','bet365','unibet'].map(key=>({key,last_update:new Date().toISOString(),markets:[{key:'h2h',outcomes:[{name:'Home '+i,price:key==='pinnacle'?1.4:1.8},{name:'Draw',price:4},{name:'Away '+i,price:10}]}]}))});
const oldFetch=globalThis.fetch;
globalThis.fetch=async input=>{calls++;return new URL(input).pathname.includes('soccer_bad')?Response.json({message:'League unavailable'},{status:404}):Response.json(Array.from({length:630},(_,i)=>event(i)),{headers:{'x-requests-remaining':'20'}})};
try{
 const result=await runDualFreeScan({timeframeHours:24,maxMatches:500,minOdds:1.5,maxOdds:2.3,matchWinnerFloor:56,date:'2099-10-07',sportKeys:['soccer_test','soccer_bad'],deferDailySelection:true});
 assert.equal(result.matchesAnalyzed,500);assert.equal(result.predictionsGenerated,500);assert.equal(saved.length,500);
 assert(!saved.some(p=>p.match_id==='fixture-0'));assert(saved.some(p=>p.match_id==='fixture-599'));
 assert.equal(result.positiveEvPicks,500);assert.equal(result.dailyEligibleMatches,500);
 assert.deepEqual(result.failedLeagues,['soccer_bad']);
 const before=calls;await assert.rejects(()=>fetchOddsApiFixtures(['soccer_test'],undefined,Date.now()),/could not fetch/);assert.equal(calls,before);
 console.log('Odds API fills 500 fresh slots after deduplication, exposes partial league coverage, defers daily selection and respects its request budget.');
}finally{globalThis.fetch=oldFetch;delete globalThis.coverageDB;}
