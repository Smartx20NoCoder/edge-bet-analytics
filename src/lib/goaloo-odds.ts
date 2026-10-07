import {readPublic} from './goaloo-parser';
type Quote={market:string,bookmaker:string,odds:number,opening:number|null,timestamp:string};

// Goaloo's page script uses euro.l as decimal 1X2, and profit-only (Hong Kong)
// prices for OU, AH and double chance. Only latest pre-match prices are used.
const number=(v:unknown)=>typeof v==='string'&&v.trim()!==''||typeof v==='number'?Number(v):NaN;
const price=(v:unknown,hk=false)=>{const n=number(v);return Number.isFinite(n)&&n>0&&n+(hk?1:0)>1&&n+(hk?1:0)<=100?n+(hk?1:0):null;};
function envelope(raw:string){const e=JSON.parse(raw);if(e.ErrCode!==0||!e.Data||e.MatchState!==0)throw new Error('Goaloo did not return pre-match odds.');return e.Data;}
export function parseGoalooOdds(mixRaw:string,dcRaw:string|null,timestamp:string){
 const data=envelope(mixRaw),quotes:Quote[]=[],names=new Map<number,string>();
 if(!Array.isArray(data.mixodds))throw new Error('Goaloo odds data was incomplete.');
 const add=(market:string,bookmaker:string,latest:unknown,initial:unknown,hk=false)=>{const odds=price(latest,hk);if(odds!==null)quotes.push({market,bookmaker,odds,opening:price(initial,hk),timestamp});};
 for(const row of data.mixodds){
  if(typeof row.cn!=='string'||!row.cn.trim())continue;const book=row.cn.trim();names.set(Number(row.cid),book);
  for(const [field,key] of [['u','home'],['g','draw'],['d','away']])add(key,book,row.euro?.l?.[field],row.euro?.f?.[field]);
  const line=number(row.ou?.l?.g),initialLine=number(row.ou?.f?.g);
  // Quarter totals are omitted until the model supports their split settlement.
  if([1.5,2,2.5,3,3.5].includes(line))for(const [field,side] of [['u','over'],['d','under']])add(`total-${side}-${line}`,book,row.ou?.l?.[field],initialLine===line?row.ou?.f?.[field]:null,true);
  const handicap=number(row.ah?.l?.g),initialHandicap=number(row.ah?.f?.g);
  // Positive Goaloo lines mean the home team gives goals: negate for home.
  if([-.5,-.25,0,.25,.5].includes(handicap)){
   add(`ah:home:${-handicap||0}`,book,row.ah?.l?.u,initialHandicap===handicap?row.ah?.f?.u:null,true);
   add(`ah:away:${handicap||0}`,book,row.ah?.l?.d,initialHandicap===handicap?row.ah?.f?.d:null,true);
  }
 }
 if(dcRaw){const dc=envelope(dcRaw);if(!Array.isArray(dc.oddsList))throw new Error('Goaloo double chance data was incomplete.');for(const row of dc.oddsList){const book=names.get(Number(row.cid));if(!book)continue;for(const [field,key] of [['u','1x'],['g','12'],['d','x2']])add(key,book,row.lodds?.[field],row.fodds?.[field],true);}}
 return quotes;
}
export async function collectGoalooOdds(id:string){
 if(!/^\d+$/.test(id))throw new Error('Invalid Goaloo match ID.');
 const request=(t:number)=>readPublic(`https://www.goaloo.com/ajax/soccerajax?type=14&t=${t}&id=${id}&h=0&s=0&flesh=${Math.random()}`);
 const mix=await request(1);
 const timestamp=new Date().toISOString(),notes:string[]=[];
 const quotes=parseGoalooOdds(mix,null,timestamp);
 if(!quotes.length)notes.push('Goaloo returned no usable prices for the modeled markets.');
 return {quotes,notes};
}
