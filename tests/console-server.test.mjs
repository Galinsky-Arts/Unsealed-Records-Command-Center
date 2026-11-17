import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAppServer,loadAppConfig} from '../src/server/app.mjs';
import {createLoginLimiter} from '../src/server/session.mjs';

const READ='engine-read-only-key-0123456789abcdefgh',WRITE='engine-console-write-key-0123456789abcd';
const env={ENGINE_URL:'https://engine.example',ENGINE_API_KEY:READ,ENGINE_WRITE_API_KEY:WRITE,ADMIN_PASSWORD:'correct horse battery staple',
 SESSION_SECRET:'s'.repeat(48),APP_ORIGIN:'https://app.example',QR_SIGNING_SECRET:'q'.repeat(40)};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const accounts=[{id:'11111111-1111-4111-8111-111111111111',email:'mgr@example.test',role:'label_manager',labelIds:['alpha-label'],disabled:false},
 {id:'22222222-2222-4222-8222-222222222222',email:'viewer@example.test',role:'team_member',labelIds:['alpha-label'],disabled:false}];

async function withApp(fn,extra={}){
 const dir=await mkdtemp(join(tmpdir(),'urc-console-'));await writeFile(join(dir,'index.html'),'<!doctype html>');
 const calls=[];
 const engine=async(url,options)=>{
  const u=new URL(String(url)),body=options.body?JSON.parse(options.body):undefined;calls.push({path:u.pathname+u.search,method:options.method,auth:options.headers.authorization,acting:options.headers['x-acting-user'],body});
  if(u.pathname==='/v1/accounts/verify'){const a=accounts.find(x=>x.email===body.email);return a&&body.password==='a valid long password'&&!a.disabled?json({account:a}):json({error:'Unauthorized'},401);}
  if(u.pathname==='/v1/accounts'&&options.method==='GET')return json({accounts});
  if(u.pathname==='/v1/alerts/feed')return json({alerts:[{fingerprint:'a'.repeat(64),labelId:'alpha-label'}]});
  if(u.pathname==='/v1/budgets'&&body?.amountMinor==='bad')return json({error:'amountMinor must be an exact integer'},422);
  if(u.pathname==='/v1/budgets')return json({budget:body});
  return json({ok:true,path:u.pathname});
 };
 const config=loadAppConfig({...env,DIST_DIR:dir,...extra});
 const server=createAppServer(config,{fetchImpl:engine,limiter:createLoginLimiter({maxPerClient:100,maxPerAccount:100})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const login=async(username,password)=>{const r=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:'https://app.example'},body:JSON.stringify({username,password})});
  return r.status===200?r.headers.get('set-cookie').split(';')[0]:r.status;};
 const post=(cookie,path,body,headers={})=>fetch(base+path,{method:'POST',headers:{cookie,'content-type':'application/json',origin:'https://app.example',...headers},body:JSON.stringify(body)});
 try{await fn({base,calls,login,post});}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
}

test('engine accounts sign in with their role and label scope; writes are role- and label-checked',async()=>{
 await withApp(async({base,calls,login,post})=>{
  assert.equal(await login('mgr@example.test','wrong password value'),401);
  const mgr=await login('mgr@example.test','a valid long password');assert.equal(typeof mgr,'string');
  const info=await (await fetch(base+'/api/session',{headers:{cookie:mgr}})).json();
  assert.equal(info.role,'label_manager');assert.deepEqual(info.labels,['alpha-label']);assert.equal(info.permissions.write,true);assert.equal(info.permissions.manage,false);
  let r=await post(mgr,'/api/v1/budgets',{labelId:'alpha-label',id:'b',name:'B',period:'2026-11',amountMinor:'100'});
  assert.equal(r.status,200);
  const call=calls.find(c=>c.path==='/v1/budgets');assert.equal(call.auth,'Bearer '+WRITE);assert.equal(call.acting,'account:mgr@example.test');
  assert.equal((await post(mgr,'/api/v1/budgets',{labelId:'beta-label',id:'b',name:'B',period:'2026-11',amountMinor:'100'})).status,403);
  r=await post(mgr,'/api/v1/budgets',{labelId:'alpha-label',amountMinor:'bad'});
  assert.equal(r.status,422);assert.match((await r.json()).error,/exact integer/);
  assert.equal((await post(mgr,'/api/v1/royalties/statements',{labelId:'alpha-label',period:'2026-10',finalize:true})).status,403);
  assert.equal((await post(mgr,'/api/v1/royalties/statements',{labelId:'alpha-label',period:'2026-10'})).status,200);
  assert.equal((await post(mgr,'/api/v1/royalties/payouts',{labelId:'alpha-label'})).status,403);
  assert.equal((await post(mgr,'/api/admin/users',{email:'x@example.test'})).status,403);
  assert.equal((await post(mgr,'/api/v1/alerts/feed/'+'a'.repeat(64)+'/ack',{})).status,200);
  assert.equal((await post(mgr,'/api/v1/alerts/feed/'+'b'.repeat(64)+'/ack',{})).status,404);
  assert.equal((await post(mgr,'/api/v1/budgets',{labelId:'alpha-label'},{origin:'https://evil.example'})).status,403);
  assert.equal((await post(mgr,'/api/v1/ingest',{labelId:'alpha-label'})).status,405,'raw ingest is not exposed');
  // Scoped reads still require explicit, allowed labels.
  assert.equal((await fetch(base+'/api/v1/budgets',{headers:{cookie:mgr}})).status,403);
  assert.equal((await fetch(base+'/api/v1/budgets?labelId=alpha-label',{headers:{cookie:mgr}})).status,200);
  const viewer=await login('viewer@example.test','a valid long password');
  assert.equal((await post(viewer,'/api/v1/budgets',{labelId:'alpha-label'})).status,403);
  // Disabling the account ends its session at the next check.
  accounts[1].disabled=true;
  const later=await login('viewer@example.test','a valid long password');assert.equal(later,401);
  accounts[1].disabled=false;
 });
});

test('administrators manage users and demo data through the engine; QR links are signed and scans are counted anonymously',async()=>{
 await withApp(async({base,calls,login,post})=>{
  const admin=await login('admin','correct horse battery staple');
  let r=await fetch(base+'/api/admin/users',{headers:{cookie:admin}});
  assert.equal(r.status,200);const body=await r.json();assert.equal(body.accounts.length,2);assert.equal(body.localAdmin.username,'admin');
  r=await post(admin,'/api/admin/users',{email:'new@example.test',role:'team_member',labelIds:['alpha-label'],password:'a valid long password'});
  assert.equal(r.status,200);assert.equal(calls.at(-1).path,'/v1/accounts');assert.equal(calls.at(-1).acting,'local:admin');
  r=await post(admin,'/api/admin/users/'+accounts[0].id,{disabled:true});assert.equal(calls.at(-1).path,'/v1/accounts/'+accounts[0].id);
  r=await post(admin,'/api/admin/demo-data',{});assert.equal(calls.at(-1).path,'/v1/admin/demo-data');
  r=await post(admin,'/api/qr/issue',{labelId:'alpha-label',eventId:'event-0001',campaignId:'campaign-01',expiresInHours:2});
  assert.equal(r.status,200);const {url}=await r.json();assert.match(url,/^https:\/\/app\.example\/q\//);
  const path=new URL(url).pathname;
  r=await fetch(base+path);assert.equal(r.status,200);assert.match(await r.text(),/counted anonymously/);
  const scan=calls.find(c=>c.path==='/v1/ingest');
  assert.equal(scan.body.source,'qr-campaign');assert.equal(scan.body.facts[0].type,'attendance');assert.equal(scan.body.facts[0].metadata.verified,false);
  const before=calls.length;await fetch(base+path);assert.equal(calls.length,before,'repeat scan from the same client is not re-sent');
  assert.equal((await fetch(base+path.slice(0,-3)+'AAA')).status,404);
 });
});

test('without the write key the console stays read-only and says what to configure',async()=>{
 await withApp(async({base,login,post})=>{
  const admin=await login('admin','correct horse battery staple');
  const info=await (await fetch(base+'/api/session',{headers:{cookie:admin}})).json();
  assert.equal(info.features.write,false);assert.equal(info.features.qr,true);
  const r=await post(admin,'/api/v1/budgets',{labelId:'alpha-label'});
  assert.equal(r.status,503);assert.match((await r.json()).message,/ENGINE_WRITE_API_KEY/);
  assert.equal(await login('mgr@example.test','a valid long password'),401);
 },{ENGINE_WRITE_API_KEY:''});
});
