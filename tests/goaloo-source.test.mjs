import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const dbSource=`const cache=new Map();export const supabaseAdmin={from(){let key;return {select(){return this},eq(_,v){key=v;return this},async maybeSingle(){return {data:cache.get(key)}},async upsert(v){cache.set(v.match_id,v);return {error:null}}}}};`;
registerHooks({resolve(s,c,next){if(s==='@/integrations/supabase/client.server')return {url:'data:text/javascript,'+encodeURIComponent(dbSource),shortCircuit:true};if(s.startsWith('./')&&!/\.[a-z]+$/.test(s))s+='.ts';return next(s,c);}});
const {fetchScheduleByDate,fetchResultsByDate,fetchLiveOdds}=await import('../src/lib/goaloo.server.ts');
const calls=[];
globalThis.fetch=async input=>{
 const u=new URL(input);calls.push(u.href);
 assert.equal(u.hostname,'www.goaloo.com');assert.equal(u.searchParams.has('api_key'),false);
 if(u.pathname.includes('/live-')){const id=u.pathname.split('live-')[1];return new Response(`<script>var scheduleId = ${id}; var m={state:parseInt('-1')}</script><div id="mScore">${id==='456'?'Match awarded 3–0':'Finished 2–1'}</div>`);}
 if(u.searchParams.get('type')==='6')return new Response(JSON.stringify({ErrCode:0,Data:"var matchcount=3;B[1]=[1,'','League'];A[1]=[123,1,11,22,'Home','Away','2099,9,7,12,00,00',0,0,0,0,0,0,0,0,0,'3','4','','',0,'','',0,0,0];A[2]=[456,1,11,22,'Home','Away','2099,9,7,10,00,00',-1,2,1,0,0,0,0,0,0,'3','4','','',0,'','',6,3,0];A[3]=[789,1,11,22,'Home','Away','2099,9,7,09,00,00',-1,2,1,0,0,0,0,0,0,'3','4','','',0,'','',0,0,0];".replace(globalThis.voidSchedule?",-1,2,1,":'not-present',',-14,0,0,')}));
 return new Response(JSON.stringify({ErrCode:0,MatchState:0,Data:{mixodds:['A','B'].map(cn=>({cn,euro:{l:{u:2,g:3,d:4}},ou:{l:{g:2.5,u:.9,d:.8}},ah:{l:{g:-.5,u:.8,d:1}}}))}}));
};
const fixtures=await fetchScheduleByDate('2099-10-07');assert.equal(fixtures.length,1);assert.equal(fixtures[0].matchId,'goaloo:123');assert.equal(fixtures[0].homeId,'11');assert.equal(fixtures[0].raw.state,0);
assert.ok(calls[0].includes('timezone=0'));
const results=await fetchResultsByDate('2099-10-07');assert.equal(results.length,2);assert.equal(results[1].homeCorners,null);assert.equal(results[1].awayCorners,null);assert.deepEqual([results[0].homeScore,results[0].awayScore,results[0].homeCorners,results[0].awayCorners],[2,1,6,3]);
const odds=await fetchLiveOdds('goaloo:123');assert.equal(odds.matchWinner.oH,2);assert.equal(odds.goals25.oOver,1.9);assert.equal(odds.ahHomePlus.odds,1.8);
const before=calls.length;await fetchLiveOdds('goaloo:123');assert.equal(calls.length,before);
await assert.rejects(()=>fetchLiveOdds('123'));await assert.rejects(()=>fetchScheduleByDate('2099-02-30'));
console.log('Goaloo server schedule, finished results, live odds, caching and key-free source isolation passed');

const verified=await fetchResultsByDate('2099-10-07',[{match_id:'goaloo:456'},{match_id:'goaloo:789'}]);assert.equal(verified.find(r=>r.matchId==='goaloo:456').status,'AWARDED');assert.equal(verified.find(r=>r.matchId==='goaloo:456').homeCorners,null);assert.equal(verified.find(r=>r.matchId==='goaloo:789').status,'FT');
console.log('Saved result page notices are verified before grading; ordinary results retain FT status.');

globalThis.voidSchedule=true;const postponed=await fetchResultsByDate('2099-10-08',[{match_id:'goaloo:456'}]);assert.equal(postponed[0].status,'POSTPONED');assert.equal(postponed[0].homeScore,null);assert.equal(postponed[0].awayScore,null);
console.log('Unplayed postponed fixtures are returned as void with no invented 0–0 score.');
