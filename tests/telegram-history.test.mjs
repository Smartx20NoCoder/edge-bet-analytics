import assert from 'node:assert/strict';
const {tables}=await import('./telegram-singles.test.mjs');
const archive=await import('../src/lib/telegram-archive.server.ts');
const server=await import('../src/lib/telegram.server.ts');
const fetchBefore=globalThis.fetch,timerBefore=globalThis.setTimeout;
let sent=[],rateLimit=false,deleted=false,uncertain=false,waits=[];
globalThis.setTimeout=(fn,ms,...args)=>{waits.push(ms);return timerBefore(fn,0,...args)};
globalThis.fetch=async(url,opts)=>{
 const method=String(url).split('/').at(-1),body=JSON.parse(opts.body);
 if(method==='sendMessage'){
  if(rateLimit){rateLimit=false;return Response.json({ok:false,error_code:429,parameters:{retry_after:120}});}
  if(uncertain)throw new Error('Unconfirmed delivery');
  sent.push(body.text.match(/Daily selection: (\d{4}-\d{2}-\d{2})/)?.[1]);return Response.json({ok:true,result:{message_id:100+sent.length}});
 }
 if(method==='editMessageText')return Response.json(deleted?{ok:false,error_code:400,description:'Bad Request: message to edit not found'}:{ok:false,error_code:400,description:'Bad Request: message is not modified'});
 throw new Error('Unexpected Telegram method');
};
try{
 process.env.TELEGRAM_BOT_TOKEN='unit-test-token';
 tables.edge_telegram_settings[0].enabled=true;
 for(const name of ['edge_telegram_archives','edge_telegram_deliveries','daily_best_picks','predictions'])tables[name].length=0;
 for(let day=1;day<=5;day++){
  const date=`2026-09-0${day}`,id='history-'+day;
  tables.daily_best_picks.push({day:date,single_prediction_id:id});
  tables.predictions.push({id,home_team:'Home',away_team:'Away',league_name:'League',kickoff:date+'T12:00:00Z',prediction_type:'match_winner',selection:'Home win',market_odds:1.8,confidence:65,expected_value:.17,is_correct:true,ft_status:-1,home_score:2,away_score:0});
 }
 await archive.startTelegramArchive();rateLimit=true;
 await archive.runTelegramArchiveBatch();assert.equal(tables.edge_telegram_archives[0].cursor,null);assert.equal(sent.length,0);assert(Date.parse(tables.edge_telegram_archives[0].next_attempt_at)>Date.now()+110000);
 assert.equal((await archive.runTelegramArchiveBatch()).reason,'waiting');
 tables.edge_telegram_archives[0].next_attempt_at=new Date(0).toISOString();tables.edge_telegram_deliveries[0].retry_at=new Date(0).toISOString();
 await Promise.all([archive.runTelegramArchiveBatch(),archive.runTelegramArchiveBatch()]);assert.deepEqual(sent,['2026-09-01','2026-09-02','2026-09-03']);assert.equal(tables.edge_telegram_archives[0].cursor,'2026-09-03');assert(waits.filter(ms=>ms===4000).length>=3);
 tables.edge_telegram_archives[0].next_attempt_at=new Date(0).toISOString();await archive.runTelegramArchiveBatch();assert.equal(tables.edge_telegram_archives[0].state,'complete');assert.deepEqual(sent,['2026-09-01','2026-09-02','2026-09-03','2026-09-04','2026-09-05']);
 // A new archive pass verifies old message IDs; confirmed deleted messages are
 // retried before the cursor is advanced to any later day.
 tables.edge_telegram_archives[0].cursor=null;tables.edge_telegram_archives[0].state='queued';tables.edge_telegram_archives[0].next_attempt_at=new Date(0).toISOString();deleted=true;
 await archive.runTelegramArchiveBatch();assert.equal(tables.edge_telegram_archives[0].cursor,null);assert.equal(tables.edge_telegram_deliveries[0].message_id,null);assert.equal(tables.edge_telegram_deliveries[0].status,'queued');
 deleted=false;tables.edge_telegram_archives[0].next_attempt_at=new Date(0).toISOString();await archive.runTelegramArchiveBatch();assert.equal(sent.at(-1),'2026-09-01');
 await archive.startTelegramArchive(true);assert.equal(tables.edge_telegram_archives[0].cursor,null);assert(tables.edge_telegram_deliveries.every(r=>r.message_id===null&&r.status==='queued'));assert.equal(tables.edge_telegram_deliveries[0].pick_snapshot.selection,'Home win');
 uncertain=true;await archive.runTelegramArchiveBatch();assert.equal(tables.edge_telegram_archives[0].state,'paused');assert.equal(tables.edge_telegram_archives[0].cursor,null);
 assert.equal((await archive.runTelegramArchiveBatch()).reason,'no_active_history');
 console.log('History queue: persistent chronological batches, flood-wait handling, no cursor advance on failure, concurrent-worker protection, deleted-post recovery, explicit cleared-channel restart and uncertain-send pause passed.');
}finally{globalThis.fetch=fetchBefore;globalThis.setTimeout=timerBefore;}
