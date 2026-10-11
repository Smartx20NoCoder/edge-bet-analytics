import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const tables={edge_telegram_settings:[],edge_telegram_deliveries:[],predictions:[],daily_best_picks:[]};
class Query{
 constructor(table){this.table=table;this.filters=[];this.mode='read';}
 select(){return this}eq(k,v){this.filters.push(r=>r[k]===v);return this}gte(k,v){this.filters.push(r=>r[k]>=v);return this}lte(k,v){this.filters.push(r=>r[k]<=v);return this}gt(k,v){this.filters.push(r=>r[k]>v);return this}in(k,v){this.filters.push(r=>v.includes(r[k]));return this}not(k,op,v){this.filters.push(r=>v===null?r[k]!=null:r[k]!==v);return this}
 order(k,opts={}){this.sort=[k,opts.ascending!==false];return this}limit(n){this.cap=n;return this}maybeSingle(){this.single=true;return this}
 update(value){this.mode='update';this.value=value;return this}upsert(value,options){this.mode='upsert';this.value=value;this.options=options;return this}
 then(resolve,reject){try{const source=tables[this.table];assert(source,'Unexpected table '+this.table);let rows=source.filter(r=>this.filters.every(f=>f(r)));if(this.mode==='update')rows.forEach(r=>Object.assign(r,structuredClone(this.value)));if(this.mode==='upsert'){const keys=this.options.onConflict.split(',');let row=source.find(r=>keys.every(k=>r[k]===this.value[k]));if(!row){row={message_id:null,content_hash:null,error:null,...structuredClone(this.value)};source.push(row)}else if(!this.options.ignoreDuplicates)Object.assign(row,structuredClone(this.value));rows=[row]}
 if(this.sort){const [key,asc]=this.sort;rows=[...rows].sort((a,b)=>String(a[key]).localeCompare(String(b[key]))*(asc?1:-1))}if(this.cap)rows=rows.slice(0,this.cap);return Promise.resolve({data:this.single?rows[0]??null:structuredClone(rows),error:null}).then(resolve,reject)}catch(e){return Promise.reject(e).then(resolve,reject)}}
}
globalThis.mockDB={from:t=>new Query(t)};
const modules={
 '@/integrations/supabase/client.server':`export const supabaseAdmin=globalThis.mockDB;`,
 './admin-auth.server.ts':`export async function requireAdmin(token){if(token!=='test-admin-token-valid')throw new Error('Administrator access required')}`,
 '@tanstack/react-start':`export const createServerFn=()=>({inputValidator(fn){this.validate=fn;return this},handler(fn){const validate=this.validate;return async arg=>fn({data:validate(arg.data)})}});`,
};
registerHooks({resolve(s,c,next){if(s.startsWith('./')&&!/\.[cm]?[jt]sx?$/.test(s))s+='.ts';if(modules[s])return {url:'data:text/javascript,'+encodeURIComponent(modules[s]),shortCircuit:true};return next(s,c)}});
const store=await import('../src/lib/telegram.server.ts'),api=await import('../src/lib/telegram-api.server.ts'),functions=await import('../src/lib/telegram.functions.ts');
const {edgeSingleText}=await import('../src/lib/telegram-single-format.ts');
let calls=[],sendFailure=null,permissions=true,publicChannel=false,messageId=100;
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{const method=String(url).split('/').at(-1),body=JSON.parse(options.body);calls.push({method,body});let result;
 if(method==='getMe')result={id:1,username:'TDLacca_bot'};
 else if(method==='getChat')result={id:-100123456789,title:'Private Picks',type:'channel',...(publicChannel?{username:'public'}:{})};
 else if(method==='getChatMember')result={status:'administrator',can_post_messages:permissions,can_edit_messages:permissions};
 else if(method==='getUpdates')result=[{channel_post:{chat:{id:-100123456789,title:'Private Picks',type:'channel'}}}];
 else if(method==='sendMessage'){if(sendFailure==='uncertain')throw new Error('SECRET-in-a-network-url');if(sendFailure==='rejected')return Response.json({ok:false,error_code:429});result={message_id:messageId++};}
 else if(method==='editMessageText')result={message_id:body.message_id};else throw new Error('Unexpected method '+method);
 return Response.json({ok:true,result});
};
try{
 delete process.env.TELEGRAM_BOT_TOKEN;assert.equal((await store.edgeTelegramStatus()).tokenConfigured,false);
 await assert.rejects(()=>functions.getEdgeTelegramStatus({data:{accessToken:'test-non-admin-token-valid'}}),/Administrator/);await assert.rejects(()=>functions.edgeTelegramAction({data:{accessToken:'test-non-admin-token-valid',action:'discover'}}),/Administrator/);assert.equal(calls.length,0);
 process.env.TELEGRAM_BOT_TOKEN='unit-test-token';assert.equal((await api.discoverTelegramChannels()).length,1);
 publicChannel=true;await assert.rejects(()=>store.saveEdgeTelegramSettings(true,'-100123456789'),/private/);publicChannel=false;permissions=false;await assert.rejects(()=>store.saveEdgeTelegramSettings(true,'-100123456789'),/Post Messages/);permissions=true;
 await store.saveEdgeTelegramSettings(true,'-100123456789');assert(!JSON.stringify(await store.edgeTelegramStatus()).includes('unit-test-token'));
 const now=Date.now(),day=new Date(now).toISOString().slice(0,10),pick={id:'single-1',home_team:'Home',away_team:'Away',league_name:'League',kickoff:new Date(now+3*3600000).toISOString(),prediction_type:'match_winner',selection:'Home win',market_odds:1.8,confidence:65,expected_value:.17,is_correct:null,ft_status:0,home_score:null,away_score:null};
 tables.predictions.push(pick,{...pick,id:'combo-only',expected_value:.3});tables.daily_best_picks.push({day,single_prediction_id:pick.id,combo_prediction_id_1:pick.id,combo_prediction_id_2:'combo-only'});
 calls=[];await Promise.all([store.publishEdgeSingles(),store.publishEdgeSingles()]);assert.equal(calls.filter(c=>c.method==='sendMessage').length,1);assert(calls[0].body.text.includes('EDGEBET · SINGLE'));assert(calls[0].body.text.includes('🟡 — PENDING'));assert(!calls[0].body.text.includes('Combo'));
 await store.publishEdgeSingles();assert.equal(calls.filter(c=>c.method==='sendMessage').length,1);
 pick.market_odds=2.1;pick.selection='Changed selection';pick.is_correct=true;pick.home_score=2;pick.away_score=0;pick.ft_status=-1;
 await store.syncEdgeTelegramResults();const edit=calls.find(c=>c.method==='editMessageText');assert(edit.body.text.includes('Original quoted odds: 1.80'));assert(edit.body.text.includes('Home win'));assert(edit.body.text.includes('Match status: 🟢 ✓ WON'));assert(edit.body.text.includes('Single slip: 🟢 ✓ WON'));assert(edit.body.text.includes('FT: 2–0'));
 await store.syncEdgeTelegramResults();assert.equal(calls.filter(c=>c.method==='editMessageText').length,1);
 pick.is_correct=false;await store.syncEdgeTelegramResults();assert(calls.at(-1).body.text.includes('🔴 ✕ UNSUCCESSFUL'));
 pick.ft_status='AWARDED';pick.is_correct=true;await store.syncEdgeTelegramResults();assert(calls.at(-1).body.text.includes('⚪ AWARDED · NOT GRADED'));assert(!calls.at(-1).body.text.includes('FT:'));
 const prior=new Date(now-86400000).toISOString().slice(0,10),old={...pick,id:'old-single',kickoff:new Date(now-20*3600000).toISOString(),ft_status:-1,is_correct:false};tables.predictions.push(old);tables.daily_best_picks.push({day:prior,single_prediction_id:old.id});const oldSends=calls.filter(c=>c.method==='sendMessage').length;await store.publishEdgeSingles();assert.equal(calls.filter(c=>c.method==='sendMessage').length,oldSends);
 await store.publishEdgeSingleArchive();assert(calls.some(c=>c.method==='sendMessage'&&c.body.text.includes('ARCHIVE')));
 const futureDay=new Date(now+86400000).toISOString().slice(0,10);tables.predictions.push({...pick,id:'retry-single',kickoff:new Date(now+86400000).toISOString(),is_correct:null,ft_status:0});tables.daily_best_picks.push({day:futureDay,single_prediction_id:'retry-single'});
 sendFailure='rejected';await store.publishEdgeSingles();assert.equal(tables.edge_telegram_deliveries.find(r=>r.day===futureDay).status,'failed');sendFailure=null;await store.publishEdgeSingles();assert.equal(tables.edge_telegram_deliveries.find(r=>r.day===futureDay).status,'sent');
 const uncertainDay=new Date(now+2*86400000).toISOString().slice(0,10);tables.predictions.push({...pick,id:'uncertain-single',kickoff:new Date(now+2*86400000).toISOString(),is_correct:null,ft_status:0});tables.daily_best_picks.push({day:uncertainDay,single_prediction_id:'uncertain-single'});
 sendFailure='uncertain';await store.publishEdgeSingles();sendFailure=null;const sentCount=calls.filter(c=>c.method==='sendMessage').length;await store.publishEdgeSingles();assert.equal(calls.filter(c=>c.method==='sendMessage').length,sentCount);assert.equal(tables.edge_telegram_deliveries.find(r=>r.day===uncertainDay).status,'uncertain');assert(!JSON.stringify(await store.edgeTelegramStatus()).includes('SECRET'));
 await store.saveEdgeTelegramSettings(false);const count=calls.length;await store.publishEdgeSingles();await store.syncEdgeTelegramResults();assert.equal(calls.length,count);
 assert(edgeSingleText(day,{...pick,ft_status:'VOID',is_correct:true}).includes('⚪ VOID / REFUND'));
 console.log('Edgebet Telegram: admin guards, private-channel permissions, singles-only posts, concurrent deduplication, fixed selection/odds snapshots, coloured result edits, void/awarded handling, archive exclusion, retry safety and pause passed.');
}finally{globalThis.fetch=originalFetch;delete globalThis.mockDB;}
