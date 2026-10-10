import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import fs from 'node:fs';
import ts from 'typescript';
import {watchAdminAccess} from '../src/lib/admin-access.ts';

const wait = () => new Promise(resolve => setTimeout(resolve, 10));
const admin = {id:'admin-1',app_metadata:{role:'admin'}};
let currentUser = admin;
let callback;
let pending;
let unsubscribed = false;
const states = [];
const auth = {
  getUser: async () => pending ? pending : {data:{user:currentUser},error:null},
  onAuthStateChange(fn) {callback=fn;return {data:{subscription:{unsubscribe(){unsubscribed=true}}}};},
};
const stop = watchAdminAccess(auth,value=>states.push(value));
await wait();
assert.deepEqual(states,[true]);
for (const event of ['SIGNED_IN','TOKEN_REFRESHED','SIGNED_IN']) {
  callback(event,{user:admin});
  assert.ok(states.every(Boolean),'Returning to a tab must never temporarily remove the scan panel');
  await wait();
  assert.ok(states.every(Boolean));
}
// Role revocation still takes effect after verification.
currentUser={...admin,app_metadata:{role:'viewer'}};
callback('USER_UPDATED',{user:currentUser});
await wait();assert.equal(states.at(-1),false);
currentUser=admin;callback('SIGNED_IN',{user:admin});await wait();
// A delayed successful check must not restore admin UI after sign-out.
let resolvePending;
pending = new Promise(resolve=>{resolvePending=resolve});
callback('TOKEN_REFRESHED',{user:admin});await wait();
callback('SIGNED_OUT',null);assert.equal(states.at(-1),false);
resolvePending({data:{user:admin},error:null});await wait();assert.equal(states.at(-1),false);
pending=null;
callback('SIGNED_IN',{user:admin});await wait();assert.equal(states.at(-1),true);
currentUser={id:'other-user',app_metadata:{role:'viewer'}};
callback('SIGNED_IN',{user:currentUser});assert.equal(states.at(-1),false);
await wait();assert.equal(states.at(-1),false);
stop();assert.ok(unsubscribed);
const stoppedCount=states.length;callback("SIGNED_OUT",null);await wait();assert.equal(states.length,stoppedCount);

// Run the real results-check component's effect with simulated browser events.
let effect;
let cleanup;
let timer;
let checks=0;
const listeners = new Map();
globalThis.window={setInterval(fn){timer=fn;return 1},clearInterval(){timer=null},addEventListener(name,fn){listeners.set(name,fn)},removeEventListener(name){listeners.delete(name)}};
globalThis.document={visibilityState:'visible',addEventListener(name,fn){listeners.set(name,fn)},removeEventListener(name){listeners.delete(name)}};
globalThis.captureEffect=fn=>{effect=fn};
globalThis.resultRefresh=async()=>{checks++;return {skipped:true}};
const mocks={
 'react':`export const useEffect=fn=>globalThis.captureEffect(fn);export const useRef=v=>({current:v});export const useState=v=>[v,()=>{}];`,
 'react/jsx-runtime':`export const jsx=()=>null;export const jsxs=jsx;`,
 '@tanstack/react-start':`export const useServerFn=()=>globalThis.resultRefresh;`,
 '@tanstack/react-query':`export const useQueryClient=()=>({invalidateQueries:async()=>{}});`,
 '@/lib/admin-session':`export const useAdminAccess=()=>true;export const adminAccessToken=async()=>'test-token';`,
 '@/lib/results-automation.functions':`export const refreshResultsOnOpen=()=>{};`,
};
registerHooks({
 resolve(s,c,next){
   if(c.parentURL?.includes('AutomaticResultsRefresh.tsx') && mocks[s])return {url:'data:text/javascript,'+encodeURIComponent(mocks[s]),shortCircuit:true};
   if(c.parentURL?.includes('/src/router.tsx') && s==='./routeTree.gen')return {url:'data:text/javascript,export const routeTree={}',shortCircuit:true};
   if(c.parentURL?.includes('/src/router.tsx') && s==='@tanstack/react-router')return {url:'data:text/javascript,export const createRouter=x=>x',shortCircuit:true};
   return next(s,c);
 },
 load(url,c,next){if(url.endsWith('.tsx'))return {format:'module',source:ts.transpileModule(fs.readFileSync(new URL(url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText,shortCircuit:true};return next(url,c);},
});
const {AutomaticResultsRefresh}=await import('../src/components/AutomaticResultsRefresh.tsx');
AutomaticResultsRefresh();cleanup=effect();await wait();assert.equal(checks,1);
for(let i=0;i<3;i++){listeners.get('focus')?.();listeners.get('visibilitychange')?.();await wait();}
assert.equal(checks,1,'Returning to the tab must not run another results update');
assert.ok(timer,'Scheduled results checks remain enabled');
timer();await wait();assert.equal(checks,2);
cleanup();assert.equal(timer,null);

// Exercise the actual router QueryClient across focus/reconnect and explicit refresh.
const {getRouter}=await import('../src/router.tsx');
const {QueryObserver,focusManager,onlineManager}=await import('@tanstack/react-query');
const {queryClient}=getRouter().context;
queryClient.mount();
let fetches=0;
const observer=new QueryObserver(queryClient,{queryKey:['tab-return-regression'],queryFn:async()=>++fetches});
const unsubscribe=observer.subscribe(()=>{});
await wait();assert.equal(fetches,1);
focusManager.setFocused(false);focusManager.setFocused(true);
onlineManager.setOnline(false);onlineManager.setOnline(true);
await wait();assert.equal(fetches,1,'Focus and reconnect must preserve the displayed data');
await queryClient.invalidateQueries();assert.equal(fetches,2,'Explicit refresh after scans/results updates still works');
unsubscribe();queryClient.unmount();queryClient.clear();
console.log('Tab return: stable admin panel, role revocation/sign-out races, results timer, focus/reconnect and explicit refresh passed');
