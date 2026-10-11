import {supabaseAdmin} from '@/integrations/supabase/client.server';
import {randomUUID} from 'node:crypto';
import {edgeTelegramStatus,publishArchiveDay} from './telegram.server';
const db=supabaseAdmin as any;
export async function archiveStatus(chatId:string|null){
 if(!chatId)return null;
 const {data,error}=await db.from('edge_telegram_archives').select('*').eq('chat_id',chatId).maybeSingle();
 if(error)throw new Error('History queue is unavailable.');return data;
}
export async function startTelegramArchive(restart=false){
 const config=await edgeTelegramStatus();
 if(!config.enabled||!config.chat_id||!config.tokenConfigured)throw new Error('Connect and enable your channel first.');
 const prior=await archiveStatus(config.chat_id);
 if(prior?.state==='running'&&Date.parse(prior.lease_until)>Date.now())throw new Error('A history batch is running. Wait for it to finish.');
 if(restart){
  // Explicit admin action after clearing picks from the channel. Preserve every
  // original prediction snapshot; only forget the deleted Telegram messages.
  const {error}=await db.from('edge_telegram_deliveries').update({message_id:null,content_hash:null,status:'queued',error:null,retry_at:null,updated_at:new Date().toISOString()}).eq('chat_id',config.chat_id);
  if(error)throw new Error('Could not reset the cleared channel records.');
 }
 const row={chat_id:config.chat_id,state:'queued',cursor:restart?null:prior?.cursor??null,through_day:new Date().toISOString().slice(0,10),processed:restart?0:prior?.processed??0,error:null,next_attempt_at:new Date().toISOString(),lease_until:null,run_id:null,updated_at:new Date().toISOString()};
 const {error}=await db.from('edge_telegram_archives').upsert(row,{onConflict:'chat_id'});
 if(error)throw new Error('Could not queue saved history.');return row;
}
export async function runTelegramArchiveBatch(){
 const config=await edgeTelegramStatus();
 if(!config.enabled||!config.chat_id||!config.tokenConfigured)return {skipped:true,reason:'channel_disabled'};
 const job=await archiveStatus(config.chat_id);
 if(!job||job.state==='complete'||job.state==='paused')return {skipped:true,reason:'no_active_history'};
 if(Date.parse(job.next_attempt_at)>Date.now()||job.state==='running'&&Date.parse(job.lease_until)>Date.now())return {skipped:true,reason:'waiting'};
 const runId=randomUUID(),now=new Date().toISOString();
 const {data:claimed,error}=await db.from('edge_telegram_archives').update({state:'running',run_id:runId,lease_until:new Date(Date.now()+90000).toISOString(),updated_at:now}).eq('chat_id',job.chat_id).eq('updated_at',job.updated_at).select('chat_id');
 if(error)throw new Error('Could not claim history batch.');if(!claimed?.length)return {skipped:true,reason:'another_batch_claimed'};
 let cursor=job.cursor,processed=job.processed??0;
 async function save(value:Record<string,unknown>){const {error}=await db.from('edge_telegram_archives').update({cursor,processed,...value,updated_at:new Date().toISOString()}).eq('chat_id',job.chat_id).eq('run_id',runId);if(error)throw new Error('Could not save history progress.');}
 try{
  const {data:days,error}=await db.from('daily_best_picks').select('day,single_prediction_id').not('single_prediction_id','is',null).gt('day',cursor??'0001-01-01').lte('day',job.through_day).order('day').limit(4);
  if(error)throw new Error('Saved daily history could not be read.');
  for(const day of (days??[]).slice(0,3)){
   const result=await publishArchiveDay(day.day,day.single_prediction_id);
   if(result?.status!=='sent'){
    const uncertain=result?.status==='uncertain';
    await save({state:uncertain?'paused':'queued',error:uncertain?`Check ${day.day} in the channel before retrying; Telegram did not confirm delivery.`:result?.error??`Waiting to confirm ${day.day}.`,next_attempt_at:result?.retry_at??new Date(Date.now()+60000).toISOString(),lease_until:null});
    return {state:uncertain?'paused':'queued',cursor,processed};
   }
   cursor=day.day;processed++;
   await save({error:null});
   // Deliberate spacing below Telegram's channel flood limit, across batches.
   await new Promise(resolve=>setTimeout(resolve,4000));
  }
  const complete=(days??[]).length<=3;
  await save({state:complete?'complete':'queued',error:null,lease_until:null,next_attempt_at:new Date(Date.now()+60000).toISOString()});
  return {state:complete?'complete':'queued',cursor,processed};
 }catch(e){await save({state:'queued',error:e instanceof Error?e.message:'History batch unavailable.',lease_until:null,next_attempt_at:new Date(Date.now()+60000).toISOString()});return {state:'queued',cursor,processed};}
}
