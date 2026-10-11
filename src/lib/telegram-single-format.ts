import {isVoidStatus,settleSlip} from './slip-settlement.ts';
export type TelegramSingle={id:string,home_team:string,away_team:string,league_name:string|null,kickoff:string,prediction_type:string,selection:string,market_odds:number|string|null,confidence:number|string|null,expected_value:number|string|null,is_correct?:boolean|null,ft_status?:string|number|null,home_score?:number|null,away_score?:number|null};
export function edgeSingleStatus(p:TelegramSingle){
 if(String(p.ft_status).toUpperCase()==='AWARDED')return '⚪ AWARDED · NOT GRADED';
 const status=settleSlip([p]).status;
 return status==='won'?'🟢 ✓ WON':status==='lost'?'🔴 ✕ UNSUCCESSFUL':status==='void'?'⚪ VOID / REFUND':'🟡 — PENDING';
}
const safe=(value:unknown)=>String(value??'').replace(/[\r\n]/g,' ').slice(0,180);
export function edgeSingleText(day:string,p:TelegramSingle,archived=false){
 const kickoff=new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Lagos',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(p.kickoff));
 const types:Record<string,string>={match_winner:'Match winner',match_winner_hedged:'Hedged +0.5',over_2_5_goals:'Over 2.5 goals'};
 const lines=['EDGEBET · SINGLE OF THE DAY',`Daily selection: ${day}`];
 if(archived)lines.push('ARCHIVE · saved earlier; posted retrospectively.');
 lines.push('',`${safe(p.home_team)} vs ${safe(p.away_team)}`,safe(p.league_name)||'League unavailable',`Kickoff: ${kickoff} WAT`,`${types[p.prediction_type]??safe(p.prediction_type)} · ${safe(p.selection)}`,`Original quoted odds: ${Number(p.market_odds).toFixed(2)}`);
 if(p.confidence!==null&&Number.isFinite(Number(p.confidence)))lines.push(`Model confidence: ${Number(p.confidence).toFixed(1)}%`);
 if(p.expected_value!==null&&Number.isFinite(Number(p.expected_value)))lines.push(`Modeled EV: ${(Number(p.expected_value)*100).toFixed(1)}%`);
 lines.push('',`Match status: ${edgeSingleStatus(p)}`);
 if(!isVoidStatus(p.ft_status)&&Number.isInteger(p.home_score)&&Number.isInteger(p.away_score))lines.push(`FT: ${p.home_score}–${p.away_score}`);
 lines.push(`Single slip: ${edgeSingleStatus(p)}`,'','This is one single bet. The saved pick and original odds remain fixed. Check current bookmaker prices; model estimates do not guarantee a win.');
 return lines.join('\n').slice(0,4096);
}
