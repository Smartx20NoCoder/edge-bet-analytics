export type GoalooFixture={id:string,url:string,home:string,away:string,league:string,kickoff:string,state:number,collectedAt:string,raw:any[],leagueId:string,homeId:string,awayId:string};
export async function readPublic(url:string){
 let u=new URL(url);
 for(let redirects=0;redirects<4;redirects++){
 if(u.hostname!=='www.goaloo.com'||!/^\/(?:football\/|ajax\/SoccerAjax$|robots\.txt)/i.test(u.pathname))throw new Error('Unsupported source.');
 const r=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(18000),headers:{'User-Agent':'EdgeBetResearch/1.0','Accept':'text/html,application/json,application/xml',...(u.pathname.toLowerCase()==='/ajax/soccerajax'&&u.searchParams.get('type')==='14'?{'Referer':`https://www.goaloo.com/football/match/oddscomp-${u.searchParams.get('id')}`}:{})}});
 if(r.status>=300&&r.status<400){const location=r.headers.get('location');if(!location)throw new Error('Goaloo returned an incomplete redirect.');u=new URL(location,u);if(u.protocol!=='https:')throw new Error('Unsupported source redirect.');continue;}
 if(!r.ok)throw new Error(`Goaloo did not provide this page (${r.status}).`);
 const text=await r.text();if(text.length>6000000)throw new Error('Source page is too large.');if(/captcha|cf-chl-|Just a moment/i.test(text.slice(0,8000)))throw new Error('Goaloo requires an interactive browser for this page.');return text;
 }throw new Error('Goaloo redirected this page too many times.');
}
export const clean=(s:string)=>s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
export function scalarArray(source:string):any[]{
 const tokens=source.slice(1,-1).match(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|null|true|false|,/g)??[];
 if(tokens.join('').replace(/\s/g,'')!==source.slice(1,-1).replace(/\s/g,''))throw new Error('Goaloo schedule format changed.');
 return tokens.filter(t=>t!==',').map(t=>t[0]==="'"?t.slice(1,-1).replace(/\\(?:u([0-9a-f]{4})|x([0-9a-f]{2})|(.))/gi,(_,u,x,c)=>u||x?String.fromCharCode(parseInt(u||x,16)):({n:'\n',r:'\r',t:'\t'} as any)[c]??c):JSON.parse(t));
}
export function parseSchedule(body:string,now=new Date().toISOString()):GoalooFixture[]{
 const envelope=JSON.parse(body);if(envelope.ErrCode!==0||typeof envelope.Data!=='string')throw new Error('Goaloo schedule was unavailable.');
 const source=envelope.Data,leagues=new Map<number,any[]>();
 for(const m of source.matchAll(/B\[(\d+)\]=(\[[^\r\n]*?\]);/g))leagues.set(Number(m[1]),scalarArray(m[2]));
 const fixtures:GoalooFixture[]=[];
 for(const m of source.matchAll(/A\[(\d+)\]=(\[[^\r\n]*?\]);/g)){
 const r=scalarArray(m[2]),date=String(r[6]).split(',').map(Number),league=leagues.get(r[1]);
 if(date.length!==6||date.some(n=>!Number.isFinite(n))||!league||!r[4]||!r[5])throw new Error('Goaloo schedule contains incomplete fixtures.');
 const kickoff=new Date(Date.UTC(date[0],date[1],date[2],date[3],date[4],date[5])).toISOString();
 fixtures.push({id:String(r[0]),url:`https://www.goaloo.com/football/match/h2h-${r[0]}`,home:clean(String(r[4])),away:clean(String(r[5])),league:clean(String(league[2])),kickoff,state:Number(r[7]),collectedAt:now,raw:r,leagueId:String(r[1]),homeId:String(r[2]),awayId:String(r[3])});
 }
 const expected=Number(source.match(/var matchcount=(\d+)/)?.[1]);if(!Number.isFinite(expected)||fixtures.length!==expected)throw new Error('Goaloo schedule was incomplete. Please refresh; no partial list was used.');
 return fixtures;
}
