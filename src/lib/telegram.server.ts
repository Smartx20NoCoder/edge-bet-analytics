import {isVoidStatus} from './slip-settlement';
import {createHash} from 'node:crypto';
import {supabaseAdmin} from '@/integrations/supabase/client.server';
import {telegramApi,telegramConfigured,TelegramError,verifyTelegramChannel} from './telegram-api.server';
import {edgeSingleText,type TelegramSingle} from './telegram-single-format';
const db=supabaseAdmin as any;
const PREDICTION_FIELDS='id,home_team,away_team,league_name,kickoff,prediction_type,selection,market_odds,confidence,expected_value,is_correct,ft_status,home_score,away_score';
type Settings={enabled:boolean,chat_id:string|null,title:string|null,bot_username:string|null};
type Delivery={chat_id:string,day:string,prediction_id:string,pick_snapshot:TelegramSingle,status:string,message_id:number|null,content_hash:string|null,updated_at:string,archived:boolean};
async function settings():Promise<Settings>{
 const {data,error}=await db.from('edge_telegram_settings').select('enabled,chat_id,title,bot_username').eq('id',true).maybeSingle();
 if(error)throw new Error('Telegram settings are temporarily unavailable.');
 return data??{enabled:false,chat_id:null,title:null,bot_username:null};
}
export async function edgeTelegramStatus(){
 const config=await settings();
 const {data,error}=config.chat_id?await db.from('edge_telegram_deliveries').select('day,status,error,updated_at').eq('chat_id',config.chat_id).order('updated_at',{ascending:false}).limit(6):{data:[],error:null};
 if(error)throw new Error('Telegram delivery history is temporarily unavailable.');
 return {...config,tokenConfigured:telegramConfigured(),deliveries:data??[]};
}
export async function saveEdgeTelegramSettings(enabled:boolean,chatId?:string){
 const prior=await settings();
 const chat=enabled?await verifyTelegramChannel(chatId):null;
 const row={id:true,enabled,chat_id:chat?.chatId??prior.chat_id,title:chat?.title??prior.title,bot_username:chat?.botUsername??prior.bot_username,updated_at:new Date().toISOString()};
 const {error}=await db.from('edge_telegram_settings').upsert(row,{onConflict:'id'});
 if(error)throw new Error('Could not save the channel connection.');
 return edgeTelegramStatus();
}
async function getPrediction(id:string){
 const {data,error}=await db.from('predictions').select(PREDICTION_FIELDS).eq('id',id).maybeSingle();
 if(error)throw new Error('Saved single is temporarily unavailable.');
 return data as TelegramSingle|null;
}
async function getDelivery(config:Settings,day:string){
 const {data,error}=await db.from('edge_telegram_deliveries').select('*').eq('chat_id',config.chat_id).eq('day',day).maybeSingle();
 if(error)throw new Error('Telegram delivery record is temporarily unavailable.');
 return data as Delivery|null;
}
async function updateDelivery(row:Delivery,value:Record<string,unknown>){
 const {error}=await db.from('edge_telegram_deliveries').update(value).eq('chat_id',row.chat_id).eq('day',row.day);
 if(error)throw new Error('Telegram delivery could not be recorded.');
}
async function publishSingle(config:Settings,day:string,predictionId:string,archive=false,existingOnly=false,verifyExisting=false){
 let row=await getDelivery(config,day);
 if(existingOnly&&!row)return;
 const live=await getPrediction(row?.prediction_id??predictionId);
 if(!live)return;
 // Automatic scans publish upcoming selections, never new retrospective tips.
 if(!row&&!archive&&(!Number.isFinite(Date.parse(live.kickoff))||Date.parse(live.kickoff)<=Date.now()||live.is_correct!==null&&live.is_correct!==undefined||isVoidStatus(live.ft_status)))return;
 if(!row){
  if(!Number.isFinite(Number(live.market_odds))||Number(live.market_odds)<=1)return;
  const {error}=await db.from('edge_telegram_deliveries').upsert({chat_id:config.chat_id,day,prediction_id:predictionId,pick_snapshot:live,status:'queued',updated_at:new Date().toISOString(),archived:archive},{onConflict:'chat_id,day',ignoreDuplicates:true});
  if(error)throw new Error('Could not reserve the Telegram post.');
  row=await getDelivery(config,day);if(!row)return;
 }
 const now=new Date().toISOString();
 if(row.status==='sending'&&Date.parse(row.updated_at)<Date.now()-60000){await updateDelivery(row,{status:'uncertain',error:'Delivery was not confirmed. Check the channel before posting again.'});return;}
 if((row as any).retry_at&&Date.parse((row as any).retry_at)>Date.now())return;
 if(row.status==='sending'||row.status==='uncertain'||row.status==='editing'&&Date.parse(row.updated_at)>=Date.now()-60000)return;
 if(!row.message_id&&!row.archived&&Date.parse(live.kickoff)<=Date.now()){await updateDelivery(row,{archived:true});row.archived=true;}
 const pick={...row.pick_snapshot,is_correct:live.is_correct,ft_status:live.ft_status,home_score:live.home_score,away_score:live.away_score};
 const text=edgeSingleText(day,pick,row.archived),hash=createHash('sha256').update(text).digest('hex');
 if(row.status==='sent'&&row.content_hash===hash&&!verifyExisting)return;
 const edit=Boolean(row.message_id),state=edit?'editing':'sending';
 const {data:claimed,error:claimError}=await db.from('edge_telegram_deliveries').update({status:state,updated_at:now,error:null}).eq('chat_id',row.chat_id).eq('day',day).eq('status',row.status).eq('updated_at',row.updated_at).select('day');
 if(claimError)throw new Error('Could not claim the Telegram delivery.');if(!claimed?.length)return;
 try{
  const sent=await telegramApi(edit?'editMessageText':'sendMessage',{chat_id:row.chat_id,...(edit?{message_id:row.message_id}:{}),text,link_preview_options:{is_disabled:true}});
  await updateDelivery(row,{status:'sent',message_id:edit?row.message_id:sent.message_id,content_hash:hash,retry_at:null,updated_at:new Date().toISOString(),error:null});
 }catch(error){
  if(error instanceof TelegramError&&error.unchanged){await updateDelivery(row,{status:'sent',content_hash:hash,retry_at:null,updated_at:new Date().toISOString(),error:null});return;}
  if(edit&&error instanceof TelegramError&&error.missing){await updateDelivery(row,{status:'queued',message_id:null,content_hash:null,error:'Deleted channel post will be republished in date order.',updated_at:new Date().toISOString()});return;}
  const uncertain=!edit&&(!(error instanceof TelegramError)||error.uncertain);
  await updateDelivery(row,{status:uncertain?'uncertain':'failed',retry_at:error instanceof TelegramError&&error.retryAfter?new Date(Date.now()+error.retryAfter*1000+1000).toISOString():null,error:error instanceof TelegramError?error.message:'Telegram delivery was not confirmed. Check the channel.',updated_at:new Date().toISOString()});
 }
}
export async function publishEdgeSingles(){
 const config=await settings();if(!config.enabled||!config.chat_id||!telegramConfigured())return;
 const {data:archive}=await db.from('edge_telegram_archives').select('state').eq('chat_id',config.chat_id).maybeSingle();if(archive&&archive.state!=='complete')return;
 const from=new Date(Date.now()-86400000).toISOString().slice(0,10),until=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
 const {data,error}=await db.from('daily_best_picks').select('day,single_prediction_id').gte('day',from).lte('day',until).order('day').limit(10);
 if(error)throw new Error('Daily singles could not be read.');
 for(const lock of data??[])if(lock.single_prediction_id)await publishSingle(config,lock.day,lock.single_prediction_id);
 const {data:pending,error:pendingError}=await db.from('edge_telegram_deliveries').select('day,prediction_id').eq('chat_id',config.chat_id).in('status',['queued','failed']).order('day',{ascending:false}).limit(5);
 if(pendingError)throw new Error('Pending Telegram posts could not be read.');
 for(const row of pending??[])await publishSingle(config,row.day,row.prediction_id,false,true);
}
export async function publishEdgeSinglesSafely(){try{await publishEdgeSingles();}catch{console.warn('[telegram] Posting unavailable; saved singles are preserved.');}}
export async function syncEdgeTelegramResults(predictionIds?:string[]){
 if(predictionIds?.length===0)return;
 const config=await settings();if(!config.enabled||!config.chat_id||!telegramConfigured())return;
 const {data:archive}=await db.from('edge_telegram_archives').select('state').eq('chat_id',config.chat_id).maybeSingle();if(archive&&archive.state!=='complete')return;
 const {data,error}=await db.from('edge_telegram_deliveries').select('day,prediction_id,status').eq('chat_id',config.chat_id).not('message_id','is',null).order('day',{ascending:false}).limit(100);
 if(error)throw new Error('Posted singles could not be read.');
 for(const row of data??[])if(!predictionIds||predictionIds.includes(row.prediction_id)||row.status==='failed'||row.status==='editing')await publishSingle(config,row.day,row.prediction_id,false,true);
}
export async function syncEdgeTelegramResultsSafely(predictionIds?:string[]){try{await syncEdgeTelegramResults(predictionIds);}catch{console.warn('[telegram] Result sync unavailable; saved results are preserved.');}}
export async function publishArchiveDay(day:string,predictionId:string){
 const config=await settings();if(!config.enabled||!config.chat_id||!telegramConfigured())throw new Error('Connect and enable your channel first.');
 await publishSingle(config,day,predictionId,true,false,true);
 return getDelivery(config,day);
}
export async function publishEdgeSingleArchive(){
 const {startTelegramArchive}=await import('./telegram-archive.server');return startTelegramArchive();
}
