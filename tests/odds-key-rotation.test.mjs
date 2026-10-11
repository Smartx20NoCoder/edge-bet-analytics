import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
let entries=[],calls=[],responses=[];
globalThis.oddsDB={from(table){return {select(){return this},eq(){return this},async maybeSingle(){return {data:table==='engine_settings'?{odds_api_keys:structuredClone(entries)}:null,error:null}},async upsert(row){if(row.odds_api_keys)entries=structuredClone(row.odds_api_keys);return {error:null}}}},async rpc(name,{p_key}){assert.equal(name,'mark_edge_odds_key_exhausted');entries=entries.map(e=>e.key===p_key?{...e,exhausted_at:new Date().toISOString()}:e);return {error:null}}};
registerHooks({resolve(s,c,next){if(s==='@/integrations/supabase/client.server')return {url:'data:text/javascript,export const supabaseAdmin=globalThis.oddsDB',shortCircuit:true};return next(s,c)}});
const api=await import('../src/lib/oddsapi.server.ts');
const fetchBefore=globalThis.fetch;
const fixture={id:'fixture',sport_key:'soccer_test',home_team:'Home',away_team:'Away',commence_time:'2099-01-01T12:00:00Z'};
globalThis.fetch=async url=>{calls.push(new URL(url).searchParams.get('apiKey'));const item=responses.shift();assert(item,'Unexpected API call');return Response.json(item.body??[fixture],{status:item.status??200,headers:item.remaining===undefined?{}:{'x-requests-remaining':String(item.remaining)}})};
function reset(){entries=['one','two','three'].map(key=>({key,exhausted_at:null}));calls=[];responses=[];}
try{
 reset();responses=[{status:401,body:{error_code:'OUT_OF_USAGE_CREDITS'}},{status:401,remaining:0,body:{}},{remaining:20}];assert.equal((await api.fetchOddsApiFixtures(['soccer_test'])).length,1);assert.deepEqual(calls,['one','two','three']);assert.equal((await api.getOddsApiKeysStatus()).exhaustedKeys,2);
 reset();responses=[{remaining:0}];assert.equal((await api.fetchOddsApiFixtures(['soccer_test'])).length,1);assert.deepEqual(calls,['one']);responses=[{remaining:10}];await api.fetchOddsApiFixtures(['soccer_test']);assert.deepEqual(calls,['one','two']);
 reset();responses=[{status:401,body:{error_code:'INVALID_API_KEY'}},{remaining:10}];await api.fetchOddsApiFixtures(['soccer_test']);assert.deepEqual(calls,['one','two']);assert.equal(entries[0].exhausted_at,null);
 reset();responses=[{status:429,remaining:0,body:{}},{remaining:10}];await api.fetchOddsApiFixtures(['soccer_test']);assert.deepEqual(calls,['one','one']);
 reset();entries[0].exhausted_at=new Date().toISOString();await api.setOddsApiKeys(['four, five\nsix','four']);assert.deepEqual(entries.map(e=>e.key),['one','two','three','four','five','six']);assert(entries[0].exhausted_at);await api.setOddsApiKeys(['replacement'],true);assert.deepEqual(entries.map(e=>e.key),['replacement']);
 console.log('Odds API: three-key rollover, final-credit response retained, invalid-key fallback, same-key rate-limit retry, additive deduplicated saves and explicit replacement passed.');
}finally{globalThis.fetch=fetchBefore;delete globalThis.oddsDB;}
