import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAppServer,loadAppConfig} from '../src/server/app.mjs';
import {createLoginLimiter,deriveKeys,issueSession,readSession} from '../src/server/session.mjs';

const ENGINE_KEY='engine-server-only-key-0123456789abcdef';
const PASSWORD='correct horse battery staple';
const baseEnv={ENGINE_URL:'https://engine.example',ENGINE_API_KEY:ENGINE_KEY,ADMIN_PASSWORD:PASSWORD,
 SESSION_SECRET:'s'.repeat(48),APP_ORIGIN:'https://app.example'};

async function withApp(fn,{env={},fetchImpl,now,limiter}={}){
 const dir=await mkdtemp(join(tmpdir(),'urc-app-'));
 await mkdir(join(dir,'assets'));
 await writeFile(join(dir,'index.html'),'<!doctype html><div id="root"></div>');
 await writeFile(join(dir,'assets','app.js'),'console.log(1)');
 await writeFile(join(tmpdir(),'urc-outside-secret.txt'),'outside');
 const config=loadAppConfig({...baseEnv,DIST_DIR:dir,...env});
 const calls=[];
 const engine=fetchImpl||(async(url,options)=>{calls.push({url:String(url),options});
  return new Response(JSON.stringify({counts:{sales:'1'},scope:{labelIds:['alpha']},labels:[{id:'alpha'},{id:'beta'}],families:[{id:'f',labelIds:['alpha','beta']}]}),{headers:{'content-type':'application/json'}});});
 const server=createAppServer(config,{fetchImpl:engine,...(now?{now}:{}),...(limiter?{limiter}:{})});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 try{await fn({base,calls,config});}finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
}
const login=(base,body,headers={})=>fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json',origin:'https://app.example',...headers},body:JSON.stringify(body)});
const sessionCookie=response=>response.headers.get('set-cookie').split(';')[0];

test('configuration requires an engine key, session secret and at least one login method',()=>{
 assert.throws(()=>loadAppConfig({...baseEnv,ENGINE_API_KEY:'short'}),/ENGINE_API_KEY/);
 assert.throws(()=>loadAppConfig({...baseEnv,SESSION_SECRET:'short'}),/SESSION_SECRET/);
 assert.throws(()=>loadAppConfig({...baseEnv,SESSION_SECRET:undefined}),/SESSION_SECRET/);
 assert.throws(()=>loadAppConfig({...baseEnv,ADMIN_PASSWORD:undefined}),/ADMIN_PASSWORD or OIDC/);
 assert.throws(()=>loadAppConfig({...baseEnv,ENGINE_URL:'http://engine.example'}),/ENGINE_URL/);
 assert.throws(()=>loadAppConfig({...baseEnv,ENGINE_URL:'https://engine.example/v1?x=1'}),/ENGINE_URL/);
 assert.throws(()=>loadAppConfig({...baseEnv,OIDC_CLIENT_ID:'client'}),/incomplete OIDC/);
 const config=loadAppConfig(baseEnv);
 assert.equal(config.oidc,null);assert.equal(config.engineOrigin,'https://engine.example');
 assert.throws(()=>createAppServer({...config,adminPassword:'too-short'}),/ADMIN_PASSWORD/);
});

test('anonymous users get no engine data and the engine key is never sent to the browser',async()=>{
 await withApp(async({base,calls})=>{
  for(const path of ['/api/v1/summary','/api/session','/api/v1/scopes']){
   const r=await fetch(base+path);assert.equal(r.status,401);assert.doesNotMatch(await r.text(),new RegExp(ENGINE_KEY));
  }
  assert.equal(calls.length,0);
  const health=await fetch(base+'/healthz');assert.deepEqual(await health.json(),{status:'ok'});
  const shell=await fetch(base+'/');assert.equal(shell.status,200);
  assert.match(shell.headers.get('content-security-policy'),/default-src 'self'/);
  assert.equal(shell.headers.get('x-frame-options'),'DENY');
 });
});

test('local admin login issues an HttpOnly session and proxies only allowlisted read routes with the server key',async()=>{
 await withApp(async({base,calls})=>{
  const bad=await login(base,{username:'admin',password:'wrong password value'});assert.equal(bad.status,401);
  const good=await login(base,{username:'admin',password:PASSWORD});assert.equal(good.status,200);
  const setCookie=good.headers.get('set-cookie');
  assert.match(setCookie,/^__Host-urc_session=/);assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/Secure/);assert.match(setCookie,/SameSite=Lax/);
  const cookie=sessionCookie(good);
  const session=await fetch(base+'/api/session',{headers:{cookie}});
  const info=await session.json();assert.equal(info.authenticated,true);assert.equal(info.labels,'all');assert.equal(info.method,'local');
  const summary=await fetch(base+'/api/v1/summary?labelId=alpha',{headers:{cookie}});
  assert.equal(summary.status,200);assert.equal(summary.headers.get('x-data-provenance'),'live');
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://engine.example/v1/summary?labelId=alpha');
  assert.equal(calls[0].options.headers.authorization,'Bearer '+ENGINE_KEY);assert.equal(calls[0].options.redirect,'error');
  for(const path of ['/api/v1/ingest','/api/v1/accounts','/api/v1/jobs','/api/v1/audit','/api/v1/summary?url=https://evil','/api/v1/../health','/api/other'])
   assert.equal((await fetch(base+path,{headers:{cookie}})).status,404,path);
  assert.equal((await fetch(base+'/api/v1/summary',{method:'POST',headers:{cookie}})).status,405);
  assert.equal(calls.length,1);
 });
});

test('login and logout reject cross-origin requests, and tampered or expired sessions are refused',async()=>{
 let clock=1800000000000;
 await withApp(async({base,config})=>{
  assert.equal((await login(base,{username:'admin',password:PASSWORD},{origin:'https://evil.example'})).status,403);
  assert.equal((await login(base,{username:'admin',password:PASSWORD},{origin:''})).status,403);
  const good=await login(base,{username:'admin',password:PASSWORD});const cookie=sessionCookie(good);
  const [name,value]=cookie.split('=');
  const tampered=name+'='+value.slice(0,-2)+(value.endsWith('AA')?'BB':'AA');
  assert.equal((await fetch(base+'/api/session',{headers:{cookie:tampered}})).status,401);
  const keys=deriveKeys(config.sessionSecret);
  const forged=issueSession(deriveKeys('x'.repeat(48)),{subject:'local:admin',method:'local',labels:'*',nowMs:clock,ttlMs:1000});
  assert.equal((await fetch(base+'/api/session',{headers:{cookie:name+'='+forged}})).status,401);
  assert.ok(readSession(keys,value,clock));
  clock+=config.sessionTtlMs;
  assert.equal((await fetch(base+'/api/session',{headers:{cookie}})).status,401);
  const out=await fetch(base+'/auth/logout',{method:'POST',headers:{origin:'https://app.example'}});
  assert.match(out.headers.get('set-cookie'),/Max-Age=0/);
  assert.equal((await fetch(base+'/auth/logout',{method:'POST',headers:{origin:'https://evil.example'}})).status,403);
 },{now:()=>clock});
});

test('repeated failed logins are rate limited per client and per account',async()=>{
 let clock=0;
 const limiter=createLoginLimiter({now:()=>clock,maxPerClient:3,maxPerAccount:5});
 await withApp(async({base})=>{
  for(let i=0;i<3;i++) assert.equal((await login(base,{username:'admin',password:'wrong-'+i+'-padding'})).status,401);
  const blocked=await login(base,{username:'admin',password:PASSWORD});
  assert.equal(blocked.status,429);assert.ok(Number(blocked.headers.get('retry-after'))>0);
  clock+=15*60*1000+1;
  assert.equal((await login(base,{username:'admin',password:PASSWORD})).status,200);
  for(let i=0;i<5;i++) await login(base,{username:'admin',password:'wrong-'+i+'-padding'},{'x-forwarded-for':'10.0.0.'+i});
  assert.equal((await login(base,{username:'admin',password:PASSWORD},{'x-forwarded-for':'10.9.9.9'})).status,429);
 },{now:()=>clock,limiter,env:{TRUST_PROXY:'1'}});
});

test('engine failures are reported as unavailable without upstream detail',async()=>{
 await withApp(async({base})=>{
  const cookie=sessionCookie(await login(base,{username:'admin',password:PASSWORD}));
  const r=await fetch(base+'/api/v1/summary',{headers:{cookie}});
  assert.equal(r.status,502);assert.equal(r.headers.get('x-data-provenance'),'unavailable');
  assert.doesNotMatch(await r.text(),/provider secret/);
 },{fetchImpl:async()=>new Response('provider secret',{status:500})});
});

test('static serving cannot escape the build directory and falls back to the app shell for routes',async()=>{
 await withApp(async({base})=>{
  for(const path of ['/../urc-outside-secret.txt','/%2e%2e/urc-outside-secret.txt','/assets/../../urc-outside-secret.txt']){
   const r=await fetch(base+path);assert.doesNotMatch(await r.text(),/outside/);
  }
  const asset=await fetch(base+'/assets/app.js');assert.equal(asset.status,200);assert.match(asset.headers.get('cache-control'),/immutable/);
  const route=await fetch(base+'/releases');assert.equal(route.status,200);assert.match(await route.text(),/root/);
  assert.equal((await fetch(base+'/missing.js')).status,404);
 });
});

test('optional OIDC login issues a label-restricted session from a verified ID token',async()=>{
 const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...publicKey.export({format:'jwk'}),kid:'k1',use:'sig',alg:'RS256'};
 const clock=1800000000000;let nonce;
 const idToken=()=>{const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
  const body=enc({alg:'RS256',typ:'JWT',kid:'k1'})+'.'+enc({iss:'https://id.example',aud:'dashboard',sub:'user_1',iat:clock/1000,exp:clock/1000+300,nonce,
   labelGrants:[{labelId:'alpha',active:true,role:'viewer',expiresAtMs:clock+300000}]});
  return body+'.'+sign('RSA-SHA256',Buffer.from(body),privateKey).toString('base64url');};
 const calls=[];
 const env={ADMIN_PASSWORD:undefined,BFF_ISSUER:'https://id.example',BFF_AUDIENCE:'dashboard',BFF_JWKS_JSON:JSON.stringify({keys:[jwk]}),
  OIDC_AUTHORIZATION_ENDPOINT:'https://id.example/authorize',OIDC_TOKEN_ENDPOINT:'https://id.example/token',OIDC_CLIENT_ID:'client',OIDC_REDIRECT_URI:'https://app.example/auth/callback'};
 await withApp(async({base})=>{
  assert.equal((await login(base,{username:'admin',password:PASSWORD})).status,404);
  const start=await fetch(base+'/auth/oidc/login',{redirect:'manual'});assert.equal(start.status,302);
  const location=new URL(start.headers.get('location'));nonce=location.searchParams.get('nonce');
  const pending=start.headers.get('set-cookie').split(';')[0];
  const bad=await fetch(base+'/auth/callback?code=abc&state=wrong',{headers:{cookie:pending},redirect:'manual'});assert.equal(bad.status,401);
  const cb=await fetch(base+'/auth/callback?code=abc&state='+location.searchParams.get('state'),{headers:{cookie:pending},redirect:'manual'});
  assert.equal(cb.status,303);
  const cookie=cb.headers.getSetCookie().find(c=>c.startsWith('__Host-urc_session=')).split(';')[0];
  const info=await (await fetch(base+'/api/session',{headers:{cookie}})).json();
  assert.deepEqual(info.labels,['alpha']);assert.equal(info.method,'oidc');
  assert.equal((await fetch(base+'/api/v1/summary?labelId=alpha',{headers:{cookie}})).status,200);
  assert.equal((await fetch(base+'/api/v1/summary?labelId=beta',{headers:{cookie}})).status,403);
  assert.equal((await fetch(base+'/api/v1/summary',{headers:{cookie}})).status,403);
  assert.equal((await fetch(base+'/api/v1/summary?familyId=f',{headers:{cookie}})).status,403);
  const scopes=await (await fetch(base+'/api/v1/scopes',{headers:{cookie}})).json();
  assert.deepEqual(scopes.labels,[{id:'alpha'}]);assert.deepEqual(scopes.families,[]);
 },{env,now:()=>clock,fetchImpl:async(url,options)=>{
  calls.push(String(url));
  if(String(url)==='https://id.example/token') return new Response(JSON.stringify({id_token:idToken()}),{headers:{'content-type':'application/json'}});
  return new Response(JSON.stringify({counts:{},labels:[{id:'alpha'},{id:'beta'}],families:[{id:'f',labelIds:['alpha','beta']}]}),{headers:{'content-type':'application/json'}});
 }});
});

test('reporting routes, alert thresholds and CSV exports pass through the authenticated proxy',async()=>{
 const seen=[];
 await withApp(async({base})=>{
  const cookie=sessionCookie(await login(base,{username:'admin',password:PASSWORD}));
  for(const path of ['/api/v1/alerts?labelId=alpha&staleHours=24','/api/v1/rollups/daily?labelId=alpha&cursor=abc','/api/v1/facts?limit=5','/api/v1/catalog/isrc/USAAA2600001','/api/v1/catalog/unmapped-isrcs'])
   assert.equal((await fetch(base+path,{headers:{cookie}})).status,200,path);
  const csv=await fetch(base+'/api/v1/exports/facts.csv?labelId=alpha',{headers:{cookie}});
  assert.equal(csv.status,200);assert.match(csv.headers.get('content-type'),/text\/csv/);assert.match(csv.headers.get('content-disposition'),/attachment/);
  assert.equal(await csv.text(),'a,b\r\n1,2\r\n');
  assert.equal((await fetch(base+'/api/v1/exports/facts.csv')).status,401);
  assert.equal((await fetch(base+'/api/v1/exports/other.csv',{headers:{cookie}})).status,404);
  assert.ok(seen.some(u=>u==='https://engine.example/v1/alerts?labelId=alpha&staleHours=24'));
 },{fetchImpl:async(url,options)=>{seen.push(String(url));
  if(String(url).endsWith('.csv?labelId=alpha')){assert.equal(options.headers.accept,'text/csv');return new Response('a,b\r\n1,2\r\n',{headers:{'content-type':'text/csv; charset=utf-8'}});}
  return new Response(JSON.stringify({alerts:[]}),{headers:{'content-type':'application/json'}});}});
});
