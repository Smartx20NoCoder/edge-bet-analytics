import assert from 'node:assert/strict';
import {groupHistoryDays} from '../src/lib/history-groups.ts';
const row=(id,time,source,n,p,ev,confidence)=>({id,created_at:time,data_engine:source,matches_analyzed:n,predictions_generated:p,positive_ev_count:ev,avg_confidence:confidence,score_total:p,score_won:1,score_pending:0,league_scope:'all'});
const groups=groupHistoryDays([
 row('a','2026-10-11T18:00:00Z','goaloo',60,6,2,70),
 row('b','2026-10-11T18:04:00Z','goaloo',27,3,1,80),
 row('c','2026-10-11T18:05:00Z','dual_free',20,2,2,60),
 row('d','2026-10-11T23:30:00Z','goaloo',1,0,0,null),
]);
assert.equal(groups.length,3);
assert.equal(groups[0].day,'2026-10-12');
const goaloo=groups.find(g=>g.id==='2026-10-11:goaloo');
assert.equal(goaloo.matches_analyzed,87);
assert.equal(goaloo.predictions_generated,9);
assert.equal(goaloo.positive_ev_count,3);
assert.equal(goaloo.avg_confidence,73.3);
assert.deepEqual(goaloo.analysis_ids,['a','b']);
assert.equal(goaloo.batch_count,2);
assert.equal(groups.find(g=>g.data_engine==='dual_free').matches_analyzed,20);
assert.equal(groups[0].avg_confidence,null);
console.log('History grouping: totals, separate sources, weighted confidence and WAT rollover passed');
// Exercise server grouping before pagination and complete loading beyond the DB row cap.
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/lib/predictions.functions.ts',import.meta.url),'utf8');
const builder={inputValidator(){return this},handler(fn){return fn}};
const rows=Array.from({length:1005},(_,i)=>({...row(`a${i}`,'2026-10-11T18:00:00Z',null,1,2,0,70),notes:JSON.stringify({engine:'goaloo'})}));
const picks=rows.flatMap(a=>Array.from({length:2},(_,i)=>({id:`${a.id}:${i}`,analysis_id:a.id,confidence:70,is_correct:true,expected_value:.1,prediction_type:'match_winner'})));
const db={from(table){let ids=null;const q={select(){return q},order(){return q},gte(){return q},lte(){return q},eq(){return q},in(_,v){ids=v;return q},range(from,to){const data=table==='analyses'?rows:picks.filter(p=>ids.includes(p.analysis_id));return Promise.resolve({data:data.slice(from,to+1),count:data.length,error:null});}};return q;}};
const compile=(start,end)=>ts.transpile(source.slice(source.indexOf(start),source.indexOf(end)).replace('export const','const'),{target:ts.ScriptTarget.ES2022});
const get=new Function('createServerFn','supabaseAdmin','groupHistoryDays',compile('export const getAnalyses','export const getPredictions')+';return getAnalyses;')(()=>builder,db,groupHistoryDays);
const result=await get({data:{groupByDay:true,page:1,pageSize:50}});
assert.equal(result.totalCount,1);
assert.equal(result.analyses[0].matches_analyzed,1005);
assert.equal(result.analyses[0].positive_ev_count,2010);
assert.equal(result.analyses[0].analysis_ids.length,1005);
const getP=new Function('createServerFn','supabaseAdmin',compile('export const getPredictions','export const getDashboardStats')+';return getPredictions;')(()=>builder,db);
assert.equal((await getP({data:{analysisIds:rows.map(r=>r.id)}})).predictions.length,2010);
console.log('Server pagination retains full day totals and all grouped predictions');
