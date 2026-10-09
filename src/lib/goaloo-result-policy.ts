// Match-level notices only. VAR goals/penalties and a 3-0 score are not awards.
export function awardedMatchNotice(value:unknown):string|null{
 if(typeof value!=='string')return null;
 const text=value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
 if(/\b(?:not awarded|award (?:withdrawn|overturned)|no (?:walkover|forfeit))\b/i.test(text))return null;
 const explicit=/^(?:awarded|award|awd|w\.?\s*o\.?|walk[ -]?over|forfeit(?:ed)?)$/i.test(text)
  ||/\b(?:walk[ -]?over|forfeit(?:ed|ure)?|technical (?:win|victory|defeat|result)|adjudged)\b/i.test(text)
  ||/\b(?:match|game|result|win|victory|score)\s+(?:(?:was|is|has been)\s+)?awarded\b/i.test(text)
  ||/\bawarded\s+(?:(?:a|as|as a)\s+)?(?:match|game|result|win|victory|\d+\s*[-–:]\s*\d+)\b/i.test(text);
 return explicit?text.slice(0,300):null;
}
function element(html:string,id:string){
 const open=new RegExp(`<([a-z][a-z0-9]*)\\b[^>]*\\bid=["']${id}["'][^>]*>`,'i').exec(html);if(!open)return '';
 const tag=open[1],start=open.index+open[0].length,tokens=new RegExp(`<(/?)${tag}\\b[^>]*>`,'gi');tokens.lastIndex=start;let depth=1,m;
 while((m=tokens.exec(html))){depth+=m[1]?-1:1;if(depth===0)return html.slice(start,m.index);if(m.index-start>12000)return '';}
 return '';
}
export function goalooVoidStatus(state:number):string|null {
 return state===-12?'ABANDONED':state===-14?'POSTPONED':null;
}
export function verifiedGoalooStatus(html:string,expectedId:string):{state:number;awarded?:boolean;voided?:boolean;status?:string;label?:string;reason?:string}{
 const id=html.match(/var\s+scheduleId\s*=\s*(\d+)/)?.[1],state=Number(html.match(/\bstate:\s*parseInt\('(-?\d+)'\)/)?.[1]??NaN);
 if(id!==expectedId||!Number.isFinite(state))throw new Error('Goaloo match status could not be verified.');
 // These are match-header/result-note containers, never the event timeline,
 // previous matches, tips, article text or the site's scripts.
 for(const id of ['mScore','explain','matchRemark','matchNote','matchExplain','match-note','match-remark','result-note']){
  const reason=awardedMatchNotice(element(html,id));if(reason)return {state,awarded:true as const,label:'Awarded result',reason};
 }
 const header=element(html,'mScore').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
 const explicit=header.match(/\b(cancelled|canceled|abandoned|postponed)\b/i)?.[1]?.toUpperCase();
 const status=explicit??goalooVoidStatus(state);
 if(status)return {state,voided:true,status,label:status};
 return {state};
}
