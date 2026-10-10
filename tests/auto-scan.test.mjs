import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const modules={
 '@tanstack/react-router':`export const createFileRoute=()=>x=>x`,
 '@/lib/cron-auth.server':`export const isCronAuthorized=r=>r.headers.get('authorization')==='Bearer test-cron-only'`,
 '@/lib/scan-automation':new URL('../src/lib/scan-automation.ts',import.meta.url).href,
 '@/lib/analyze-stream.server':`export const handleAnalyzeStream=async(request)=>{globalThis.invoked++;globalThis.scanParams=new URL(request.url).searchParams;return new Response(JSON.stringify({event:'done',matchesAnalyzed:5,predictionsGenerated:2,failures:globalThis.failScan?['odds']:[]})+'\\n')}`, 
 '@/integrations/supabase/client.server':`export const supabaseAdmin={from(){let write;return {select(){return this},eq(){return this},is(){return this},single(){return Promise.resolve({data:globalThis.settings,error:null})},update(v){write=v;return this},then(resolve){if(write){globalThis.writes.push(write);resolve({data:globalThis.race?[]:[{id:true}],error:null})}else resolve({data:globalThis.settings,error:null})}}}}`,
};
registerHooks({resolve(s,c,next){if(modules[s])return {url:modules[s].startsWith('file:')?modules[s]:'data:text/javascript,'+encodeURIComponent(modules[s]),shortCircuit:true};return next(s,c)}});
const {DEFAULT_SCAN_CONFIG,ScanConfig,cronScanParams,watDay}=await import('../src/lib/scan-automation.ts');
assert.equal(watDay(new Date('2026-10-07T23:30:00Z')),'2026-10-08');
const params=cronScanParams(DEFAULT_SCAN_CONFIG,new Date('2026-10-07T09:00:00Z'));
assert.equal(DEFAULT_SCAN_CONFIG.maxMatches,500);
assert.equal(ScanConfig.parse({maxMatches:357}).maxMatches,357);
for(const maxMatches of [0,501,1.5])assert.throws(()=>ScanConfig.parse({maxMatches}));
assert.equal(params.get('maxMatches'),'500');
assert.equal(params.get('timeframeHours'),'14');assert.equal(params.get('date'),'2026-10-07');assert.equal(params.get('engine'),'combined');
const {Route}=await import('../src/routes/api/cron/auto-scan.ts');
async function run(auth=true){return Route.server.handlers.GET({request:new Request('https://example.test/api/cron/auto-scan',{headers:auth?{authorization:'Bearer test-cron-only'}:{}})})}
function reset(){Object.assign(globalThis,{settings:{scan_automation_enabled:true,scan_automation_config:DEFAULT_SCAN_CONFIG,scan_automation_last_run:null,scan_automation_status:null},writes:[],invoked:0,failScan:false,race:false})}
reset();assert.equal((await run(false)).status,401);assert.equal(globalThis.invoked,0);
reset();globalThis.settings.scan_automation_enabled=false;assert.equal((await (await run()).json()).reason,'automation_disabled');assert.equal(globalThis.invoked,0);
reset();globalThis.settings.scan_automation_status={day:watDay(new Date()),state:'complete'};assert.equal((await (await run()).json()).reason,'already_completed_today');assert.equal(globalThis.invoked,0);
reset();globalThis.settings.scan_automation_status={state:'running'};globalThis.settings.scan_automation_last_run=new Date().toISOString();assert.equal((await (await run()).json()).reason,'already_running');
reset();globalThis.race=true;assert.equal((await (await run()).json()).reason,'another_run_claimed');assert.equal(globalThis.invoked,0);
reset();assert.equal((await (await run()).json()).state,'complete');assert.equal(globalThis.invoked,1);assert.equal(globalThis.writes.at(-1).scan_automation_status.picks,2);
reset();globalThis.failScan=true;assert.equal((await run()).status,500);assert.equal(globalThis.writes.at(-1).scan_automation_status.state,'failed');
console.log('Daily cron: authentication, saved configuration, WAT midnight, duplicate/concurrent protection and partial failure checks passed');
