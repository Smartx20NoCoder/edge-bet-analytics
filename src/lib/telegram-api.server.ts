// Server-only callers. Never return or log the bot token or a Telegram request URL.
export class TelegramError extends Error {
 constructor(message:string,readonly uncertain=false,readonly unchanged=false){super(message);}
}
export function telegramConfigured(){return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim());}
export async function telegramApi<T=any>(method:string,body:Record<string,unknown>={}):Promise<T>{
 const token=process.env.TELEGRAM_BOT_TOKEN?.trim();
 if(!token)throw new TelegramError('Add TELEGRAM_BOT_TOKEN to the production Vercel environment, then redeploy.');
 let data:any;
 try{const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(12000)});data=await response.json();}
 catch{throw new TelegramError('Telegram did not confirm the request. Check the channel before retrying a new post.',true);}
 if(!data?.ok){
  const unchanged=method==='editMessageText'&&typeof data?.description==='string'&&data.description.includes('message is not modified');
  const messages:Record<number,string>={401:'The Telegram bot token is invalid. Update it in Vercel and redeploy.',403:'The bot cannot access this channel. Check its administrator permissions.',409:'This bot has another active connection. Use a dedicated bot, or enter the channel ID manually.',429:'Telegram is limiting requests. Try again later.'};
  throw new TelegramError(unchanged?'Post already up to date.':messages[data?.error_code]??'Telegram rejected the request. Check the channel ID and bot permissions.',false,unchanged);
 }
 return data.result as T;
}
export async function verifyTelegramChannel(value:unknown){
 if(typeof value!=='string'||!/^-[1-9]\d{4,15}$/.test(value))throw new Error('Choose a discovered channel or enter its numeric channel ID.');
 const bot=await telegramApi('getMe');
 const chat=await telegramApi('getChat',{chat_id:value});
 if(chat.type!=='channel'||chat.username)throw new Error('Choose your private Telegram channel.');
 const member=await telegramApi('getChatMember',{chat_id:value,user_id:bot.id});
 if(member.status!=='administrator'||!member.can_post_messages||!member.can_edit_messages)throw new Error('Give your bot administrator permissions to Post Messages and Edit Messages.');
 return {chatId:String(chat.id),title:String(chat.title??'Private channel').slice(0,150),botUsername:bot.username as string};
}
export async function discoverTelegramChannels(){
 await telegramApi('getMe');
 const updates=await telegramApi<any[]>('getUpdates',{limit:100,timeout:0,allowed_updates:['channel_post','my_chat_member']});
 const chats=new Map<string,{chatId:string,title:string}>();
 for(const update of updates){const chat=update.channel_post?.chat??update.my_chat_member?.chat;if(chat?.type==='channel'&&!chat.username)chats.set(String(chat.id),{chatId:String(chat.id),title:String(chat.title??'Private channel').slice(0,150)});}
 return [...chats.values()];
}
