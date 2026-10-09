import assert from 'node:assert/strict';
import {selectDailyPair} from '../src/lib/daily-pick-selection.ts';
const a={id:'a',match_id:'goaloo:1',home_team:'Home FC',away_team:'Away',kickoff:'2099-01-01T12:00:00Z',expected_value:.1,is_correct:null};
const b={...a,id:'b',match_id:'odds-api-id',home_team:'Home',expected_value:.2};
const c={...a,id:'c',match_id:'other',home_team:'Other',expected_value:.15};
assert.deepEqual(selectDailyPair([a,b,c]),{single:b,second:c});
assert.deepEqual(selectDailyPair([c,b,a]),{single:b,second:c});
assert.deepEqual(selectDailyPair([a,{...c,expected_value:.5}]),{single:a,second:null});
// Exercise the production persistence function with an existing pre-kickoff lock.
const {readFileSync}=await import('node:fs');
const ts=await import('typescript');
const source=readFileSync(new URL('../src/lib/predictions.functions.ts',import.meta.url),'utf8');
const save=source.slice(source.indexOf('export async function lockDailyBestPickIfNeeded'),source.indexOf('export const getDailyPicks'));
const js=ts.default.transpile(save.replace('export ',''),{target:ts.default.ScriptTarget.ES2022});
let stored=null,writes=0;
const day=a.kickoff.slice(0,10);
const db={from(table){
  const query={select(){return query},in(){return query},not(){return query},gte(){return query},lte(){return query},order(){return query},
    range(){return Promise.resolve({data:[a,b,c]})},
    then(resolve,reject){return Promise.resolve({data:stored?[stored]:[]}).then(resolve,reject)},
    upsert(row,options){assert.equal(options.ignoreDuplicates,true);writes++;stored??=row;return Promise.resolve({error:null})},
    update(){throw new Error('Saved selections must never be updated')}
  };return query;
}};
const persist=new Function('supabaseAdmin','DAILY_PICK_TYPES','DAILY_PICK_EV_CEILING','selectDailyPair',js+';return lockDailyBestPickIfNeeded;')(db,[],.4,selectDailyPair);
await persist();
assert.equal(writes,1);
assert.equal(stored.day,day);
const original=structuredClone(stored);
b.expected_value=.3;c.expected_value=.35;
await persist();
assert.equal(writes,1);
assert.deepEqual(stored,original);
console.log('Daily picks rank both providers equally, avoid duplicate fixtures, and preserve saved picks on rescan before kickoff');
