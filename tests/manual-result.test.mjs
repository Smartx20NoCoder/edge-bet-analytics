import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import {z} from 'zod';
const source=fs.readFileSync('src/lib/predictions.functions.ts','utf8');
const chunk=source.slice(source.indexOf('export const saveManualFullTimeResult')).replace('export const','const');
const js=ts.transpile(chunk,{target:ts.ScriptTarget.ES2022});
const id='11111111-1111-4111-8111-111111111111';
const rows=[{id,match_id:'goaloo:1',home_team:'Home',away_team:'Away',kickoff:'2026-01-01T12:00:00Z',prediction_type:'over_2_5_goals',selection:'Over 2.5',stats:{model:'original'},ft_status:null,is_correct:null},
{id:'22222222-2222-4222-8222-222222222222',match_id:'goaloo:1',home_team:'Home',away_team:'Away',kickoff:'2026-01-02T12:00:00Z',prediction_type:'match_winner',selection:'Home Win',stats:{}},
{id:'33333333-3333-4333-8333-333333333333',match_id:'odds-other',home_team:'Home',away_team:'Away',kickoff:'2026-01-01T12:00:00Z',prediction_type:'match_winner',selection:'Away Win',stats:{}},
{id:'44444444-4444-4444-8444-444444444444',match_id:'different',home_team:'Other',away_team:'Fixture',kickoff:'2026-01-01T12:00:00Z',stats:{}}];
let denied=false,writes=0,synced=[];
const db={from(){let filter=null,patch=null;const q={select(){return q},eq(k,v){filter=[k,v];if(patch){Object.assign(rows.find(r=>r[k]===v),patch);writes++;return Promise.resolve({error:null});}return q;},single(){return Promise.resolve({data:rows.find(r=>r[filter[0]]===filter[1]),error:null})},update(v){patch=v;return q},then(resolve,reject){return Promise.resolve({data:rows.filter(r=>r[filter[0]]===filter[1]),error:null}).then(resolve,reject)}};return q;}};
const create=()=>({inputValidator(schema){return {handler(fn){return async ({data})=>fn({data:schema.parse(data)});}};}});
const grade=(type,selection,r)=>type==='over_2_5_goals'?r.homeScore+r.awayScore>2.5:selection==='Home Win'?r.homeScore>r.awayScore:r.awayScore>r.homeScore;
const fn=new Function('createServerFn','z','requireAdmin','supabaseAdmin','matchSavedResult','gradePrediction','syncEdgeTelegramResultsSafely',js+';return saveManualFullTimeResult;')(create,z,async()=>{if(denied)throw Error('Admin required')},db,p=>p.home_team==='Home'&&p.away_team==='Away',grade,async ids=>{synced=ids});
const input={accessToken:'x'.repeat(30),predictionId:id,homeScore:2,awayScore:1,source:'Official full-time result',confirmed:true};
denied=true;await assert.rejects(()=>fn({data:input}),/Admin/);assert.equal(writes,0);denied=false;
for(const patch of [{homeScore:-1},{homeScore:1.5},{awayScore:100},{confirmed:false},{source:''}])await assert.rejects(()=>fn({data:{...input,...patch}}));assert.equal(writes,0);
const ko=rows[0].kickoff;rows[0].kickoff='2099-01-01T00:00:00Z';await assert.rejects(()=>fn({data:input}),/after kickoff/);rows[0].kickoff=ko;
const saved=await fn({data:input});assert.equal(saved.updated,3);assert.equal(rows[0].is_correct,true);assert.equal(rows[1].is_correct,true);assert.equal(rows[2].is_correct,false);assert.equal(rows[0].ft_status,'FT');assert.equal(rows[0].stats.model,'original');assert.equal(rows[0].stats.manualFullTimeResult.source,input.source);assert.equal(rows[3].ft_status,undefined);assert.equal(synced.length,3);
rows[0].ft_status='AWARDED';rows[0].is_correct=null;await fn({data:{...input,homeScore:0,awayScore:0}});assert.equal(rows[0].ft_status,'FT');assert.equal(rows[0].is_correct,false);assert.equal(rows[0].stats.manualResultHistory.length,2);assert.equal(rows[0].stats.manualFullTimeResult.previous.status,'AWARDED');
console.log('Manual FT: admin guard, score confirmation/validation, future protection, postponed match IDs, provider aliases, independent grading, audit and Telegram sync passed');
