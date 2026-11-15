import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {extname,join,normalize,resolve,sep} from 'node:path';
import {readJson} from '../bff/response.mjs';
import {verifyIdentity} from '../bff/identity.mjs';
import {cookieValue,oidcLogin,unseal,validOidcConfig} from '../bff/oidc.mjs';
import {constantTimeEqualString,cookieHeader,createLoginLimiter,createPasswordVerifier,deriveKeys,issueSession,readSession,sessionCookieName} from './session.mjs';

/**
 * Production Command Center server: static app shell, authenticated same-origin API proxy and login.
 * The Engine credential never leaves this process; browsers only receive an HttpOnly session cookie.
 */
const ENGINE_ROUTES=[
 /^\/v1\/summary$/,/^\/v1\/scopes$/,/^\/v1\/sources$/,/^\/v1\/catalog$/,/^\/v1\/source-health$/,
 /^\/v1\/platforms$/,/^\/v1\/platforms\/(trackzero|scenesignal)\/summary$/,
 /^\/v1\/distributor\/rows$/,/^\/v1\/distributor\/reconciliations$/,/^\/v1\/attendance$/
];
const QUERY_KEYS=new Set(['labelId','labelIds','familyId','source','from','to','limit','cursor','eventId','sessionId','kind']);
const TYPES={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
 '.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
const CSP="default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const failure=Object.freeze({error:'UNAVAILABLE',message:'Data is unavailable'});

function baseHeaders(res){
 res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','no-referrer');
 res.setHeader('x-frame-options','DENY');res.setHeader('content-security-policy',CSP);
 res.setHeader('strict-transport-security','max-age=31536000');res.setHeader('cross-origin-opener-policy','same-origin');
}
function send(res,status,data,headers={}){
 res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});
 res.end(JSON.stringify(data));
}
async function readBody(req,max=4096){
 const chunks=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>max) throw new Error('Body too large');chunks.push(chunk);}
 const text=Buffer.concat(chunks).toString('utf8');
 const type=String(req.headers['content-type']||'');
 if(/^application\/json/i.test(type)) return JSON.parse(text||'{}');
 if(/^application\/x-www-form-urlencoded/i.test(type)) return Object.fromEntries(new URLSearchParams(text));
 throw new Error('Unsupported body');
}

function sessionSecret(value){if(value.length<32) throw new Error('Invalid configuration: SESSION_SECRET');return value;}
export function loadAppConfig(env){
 const text=(name,{optional=false}={})=>{const v=env[name];if(v===undefined||v===''){if(optional)return undefined;throw new Error('Invalid configuration: '+name);}
  if(typeof v!=='string'||v.length>65536||/[\r\n\0]/.test(v)) throw new Error('Invalid configuration: '+name);return v;};
 const engineUrl=text('ENGINE_URL',{optional:true})||text('ENGINE_ORIGIN',{optional:true});
 let engine;try{engine=new URL(engineUrl);}catch{throw new Error('Invalid configuration: ENGINE_URL');}
 const loopback=['127.0.0.1','localhost','[::1]'].includes(engine.hostname);
 if((engine.protocol!=='https:'&&!(loopback&&engine.protocol==='http:'))||engine.username||engine.password||engine.search||engine.hash||engine.pathname!=='/')
  throw new Error('Invalid configuration: ENGINE_URL');
 const engineToken=text('ENGINE_API_KEY',{optional:true})||text('ENGINE_READ_API_KEY',{optional:true})||text('ENGINE_TOKEN',{optional:true});
 if(!engineToken||engineToken.length<32) throw new Error('Invalid configuration: ENGINE_API_KEY');
 const appOrigin=text('APP_ORIGIN',{optional:true});
 if(appOrigin){const u=new URL(appOrigin);if(u.origin!==appOrigin.replace(/\/$/,'')||(u.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(u.hostname))) throw new Error('Invalid configuration: APP_ORIGIN');}
 const adminUser=text('ADMIN_USERNAME',{optional:true})||'admin';
 if(!/^[A-Za-z0-9._@-]{1,64}$/.test(adminUser)) throw new Error('Invalid configuration: ADMIN_USERNAME');
 const adminPassword=text('ADMIN_PASSWORD',{optional:true});
 const oidcNames=['BFF_ISSUER','BFF_AUDIENCE','BFF_JWKS_JSON','OIDC_AUTHORIZATION_ENDPOINT','OIDC_TOKEN_ENDPOINT','OIDC_CLIENT_ID','OIDC_REDIRECT_URI'];
 const present=oidcNames.filter(n=>env[n]);
 if(present.length&&present.length!==oidcNames.length) throw new Error('Invalid configuration: incomplete OIDC settings');
 let oidc=null;
 if(present.length){
  let jwks;try{jwks=JSON.parse(env.BFF_JWKS_JSON);if(!Array.isArray(jwks.keys)) throw new Error();}catch{throw new Error('Invalid configuration: BFF_JWKS_JSON');}
  oidc={issuer:env.BFF_ISSUER,audience:env.BFF_AUDIENCE,jwks,authorizationEndpoint:env.OIDC_AUTHORIZATION_ENDPOINT,
   tokenEndpoint:env.OIDC_TOKEN_ENDPOINT,clientId:env.OIDC_CLIENT_ID,redirectUri:env.OIDC_REDIRECT_URI};
  if(!validOidcConfig(oidc)) throw new Error('Invalid configuration: OIDC endpoints');
 }
 if(!adminPassword&&!oidc) throw new Error('Invalid configuration: ADMIN_PASSWORD or OIDC settings are required');
 const port=Number(env.PORT||3000);
 if(!Number.isSafeInteger(port)||port<1||port>65535) throw new Error('Invalid configuration: PORT');
 const sessionHours=Number(env.SESSION_TTL_HOURS||8);
 if(!(sessionHours>0&&sessionHours<=24)) throw new Error('Invalid configuration: SESSION_TTL_HOURS');
 return {engineOrigin:engine.origin,engineToken,appOrigin:appOrigin?.replace(/\/$/,''),adminUser,adminPassword,oidc,
  sessionSecret:sessionSecret(text('SESSION_SECRET')),port,sessionTtlMs:sessionHours*3600000,trustProxy:env.TRUST_PROXY==='1',
  distDir:resolve(env.DIST_DIR||'dist'),secureCookies:env.INSECURE_COOKIES!=='1'};
}

export function createAppServer(config,{fetchImpl=fetch,now=()=>Date.now(),limiter=createLoginLimiter({now})}={}){
 const keys=deriveKeys(config.sessionSecret);
 const verifyPassword=config.adminPassword?createPasswordVerifier(config.adminPassword):null;
 const distRoot=resolve(config.distDir)+sep;
 const cookieOpts={secure:config.secureCookies};
 const sessionName=config.secureCookies?sessionCookieName:'urc_session';
 const pendingName=config.secureCookies?'__Host-urc_oidc':'urc_oidc';
 const clientOf=req=>{
  if(config.trustProxy){const t=req.headers['true-client-ip']||String(req.headers['x-forwarded-for']||'').split(',')[0].trim();if(t) return String(t).slice(0,64);}
  return req.socket.remoteAddress||'unknown';
 };
 const expectedOrigin=req=>config.appOrigin||((config.secureCookies?'https://':'http://')+req.headers.host);
 const sameOrigin=req=>req.headers.origin===expectedOrigin(req)&&req.headers['sec-fetch-site']!=='cross-site';
 const currentSession=req=>readSession(keys,cookieValue(req.headers.cookie,sessionName),now());

 async function proxy(req,res,url,session){
  const enginePath=url.pathname.slice(4);
  if(!ENGINE_ROUTES.some(r=>r.test(enginePath))) return send(res,404,failure);
  if(url.search.length>1024) return send(res,404,failure);
  for(const key of url.searchParams.keys()) if(!QUERY_KEYS.has(key)) return send(res,404,failure);
  if(session.labels!=='*'){
   // OIDC sessions see only the labels granted in their signed token; the bootstrap admin sees all.
   const asked=[...url.searchParams.getAll('labelId'),...url.searchParams.getAll('labelIds').flatMap(v=>v.split(','))];
   if(enginePath!=='/v1/scopes'&&(url.searchParams.has('familyId')||!asked.length||asked.some(id=>!session.labels.includes(id)))) return send(res,403,failure);
  }
  const target=new URL(enginePath+url.search,config.engineOrigin);
  if(target.origin!==config.engineOrigin) return send(res,404,failure);
  try{
   const signal=AbortSignal.timeout(15000);
   const response=await fetchImpl(target,{method:'GET',redirect:'error',signal,headers:{authorization:'Bearer '+config.engineToken,accept:'application/json'}});
   if(!response.ok){await response.body?.cancel();return send(res,response.status===400||response.status===404?response.status:502,failure,{'x-data-provenance':'unavailable'});}
   let data=await readJson(response,{maxBytes:5_000_000,signal});
   if(session.labels!=='*'&&enginePath==='/v1/scopes'&&data&&typeof data==='object'){
    const allowed=new Set(session.labels);
    data={...data,labels:(data.labels||[]).filter(l=>allowed.has(l.id)),
     families:(data.families||[]).filter(f=>Array.isArray(f.labelIds)&&f.labelIds.every(id=>allowed.has(id)))};
   }
   return send(res,200,data,{'x-data-provenance':data?.synthetic?'synthetic':'live'});
  }catch{return send(res,502,failure,{'x-data-provenance':'unavailable'});}
 }

 async function serveStatic(req,res,url){
  let path;
  try{path=decodeURIComponent(url.pathname);}catch{return send(res,400,failure);}
  if(path.includes('\0')) return send(res,400,failure);
  let file=normalize(join(distRoot,path));
  if(!(file+sep).startsWith(distRoot)&&file+sep!==distRoot) return send(res,404,failure);
  let info=await stat(file).catch(()=>null);
  if(!info||info.isDirectory()){
   if(extname(path)) return send(res,404,failure);
   file=join(distRoot,'index.html');info=await stat(file).catch(()=>null);
   if(!info) return send(res,503,{error:'UNAVAILABLE',message:'Application build missing'});
  }
  const body=await readFile(file);
  const immutable=file.startsWith(join(distRoot,'assets')+sep);
  res.writeHead(200,{'content-type':TYPES[extname(file)]||'application/octet-stream',
   'cache-control':immutable?'public, max-age=31536000, immutable':'no-cache','content-length':body.length});
  res.end(req.method==='HEAD'?undefined:body);
 }

 return http.createServer(async(req,res)=>{
  baseHeaders(res);
  try{
   if(typeof req.url!=='string'||req.url.length>4096) return send(res,414,failure);
   const url=new URL(req.url,'http://localhost');
   if(url.pathname==='/healthz') return send(res,200,{status:'ok'});
   if(req.method==='POST'&&url.pathname==='/auth/login'){
    if(!verifyPassword) return send(res,404,failure);
    if(!sameOrigin(req)) return send(res,403,{error:'FORBIDDEN',message:'Cross-origin login refused'});
    const client=clientOf(req);
    let body;try{body=await readBody(req);}catch{return send(res,400,{error:'BAD_REQUEST',message:'Invalid login request'});}
    const username=typeof body.username==='string'?body.username.slice(0,128):'';
    const wait=limiter.blocked(client,config.adminUser);
    if(wait) return send(res,429,{error:'RATE_LIMITED',message:'Too many attempts; try again later'},{'retry-after':String(wait)});
    const passwordOk=verifyPassword(typeof body.password==='string'?body.password:'');
    if(!passwordOk||!constantTimeEqualString(username,config.adminUser)){
     limiter.fail(client,config.adminUser);
     return send(res,401,{error:'INVALID_CREDENTIALS',message:'Invalid username or password'});
    }
    limiter.succeed(client);
    const token=issueSession(keys,{subject:'local:'+config.adminUser,method:'local',labels:'*',nowMs:now(),ttlMs:config.sessionTtlMs});
    return send(res,200,{authenticated:true},{'set-cookie':cookieHeader(sessionName,token,config.sessionTtlMs/1000,cookieOpts)});
   }
   if(req.method==='POST'&&url.pathname==='/auth/logout'){
    if(!sameOrigin(req)) return send(res,403,{error:'FORBIDDEN',message:'Cross-origin logout refused'});
    return send(res,200,{authenticated:false},{'set-cookie':cookieHeader(sessionName,'',0,cookieOpts)});
   }
   if(req.method!=='GET'&&req.method!=='HEAD') return send(res,405,failure);
   if(url.pathname==='/auth/oidc/login'){
    if(!config.oidc) return send(res,404,failure);
    const {url:location,pending}=oidcLogin(config.oidc,keys.seal,now());
    res.writeHead(302,{location,'cache-control':'no-store','set-cookie':cookieHeader(pendingName,pending,300,cookieOpts)});return res.end();
   }
   if(url.pathname==='/auth/callback'){
    if(!config.oidc) return send(res,404,failure);
    const pending=unseal(cookieValue(req.headers.cookie,pendingName),keys.seal);
    res.setHeader('set-cookie',cookieHeader(pendingName,'',0,cookieOpts));
    if(!pending||!Number.isSafeInteger(pending.createdAtMs)||now()-pending.createdAtMs>300000||now()<pending.createdAtMs||
     url.searchParams.get('state')!==pending.state||!url.searchParams.get('code')) return send(res,401,failure);
    try{
     const signal=AbortSignal.timeout(8000);
     const response=await fetchImpl(config.oidc.tokenEndpoint,{method:'POST',redirect:'error',signal,
      headers:{'content-type':'application/x-www-form-urlencoded',accept:'application/json'},
      body:new URLSearchParams({grant_type:'authorization_code',code:url.searchParams.get('code'),client_id:config.oidc.clientId,redirect_uri:config.oidc.redirectUri,code_verifier:pending.verifier})});
     if(!response.ok){await response.body?.cancel();return send(res,401,failure);}
     const body=await readJson(response,{maxBytes:20000,signal});
     const identity=verifyIdentity(body.id_token,{issuer:config.oidc.issuer,audience:config.oidc.audience,jwks:config.oidc.jwks,nowMs:now()});
     if(!identity||identity.nonce!==pending.nonce) return send(res,401,failure);
     const labels=[...new Set(identity.labelGrants.filter(g=>g?.active===true&&typeof g.labelId==='string'&&Number.isSafeInteger(g.expiresAtMs)&&g.expiresAtMs>now()).map(g=>g.labelId))].slice(0,100);
     if(!labels.length) return send(res,403,failure);
     const token=issueSession(keys,{subject:'oidc:'+identity.subject,method:'oidc',labels,nowMs:now(),ttlMs:Math.min(config.sessionTtlMs,3600000)});
     res.writeHead(303,{location:'/','cache-control':'no-store','set-cookie':[cookieHeader(pendingName,'',0,cookieOpts),cookieHeader(sessionName,token,Math.min(config.sessionTtlMs,3600000)/1000,cookieOpts)]});
     return res.end();
    }catch{return send(res,401,failure);}
   }
   if(url.pathname==='/api/session'){
    const session=currentSession(req);
    const methods={password:Boolean(verifyPassword),oidc:Boolean(config.oidc)};
    if(!session) return send(res,401,{authenticated:false,methods});
    return send(res,200,{authenticated:true,subject:session.subject,method:session.method,
     labels:session.labels==='*'?'all':session.labels,expiresAtMs:session.expiresAtMs,methods});
   }
   if(url.pathname.startsWith('/api/')){
    const session=currentSession(req);
    if(!session) return send(res,401,failure);
    if(url.pathname.startsWith('/api/v1/')) return await proxy(req,res,url,session);
    return send(res,404,failure);
   }
   return await serveStatic(req,res,url);
  }catch{if(!res.headersSent) send(res,500,failure);else res.destroy();}
 });
}
