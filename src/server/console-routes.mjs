import {readJson} from '../bff/response.mjs';
import {createQrIssuer} from '../event-calendar.mjs';

/**
 * Write and administration routes for the Command Center. Every write is same-origin, role-checked and
 * label-checked here, then forwarded to the engine with the server-held console credential
 * (ENGINE_WRITE_API_KEY). The engine records the signed-in user in its audit trail via X-Acting-User.
 */
export const ROLE_PERMISSIONS=Object.freeze({
 tenant_admin:Object.freeze({read:true,write:true,manage:true}),
 label_manager:Object.freeze({read:true,write:true,manage:false}),
 team_member:Object.freeze({read:true,write:false,manage:false}),
 artist:Object.freeze({read:true,write:false,manage:false})
});
const WRITE_ROUTES=[
 {re:/^\/v1\/imports$/,perm:'write',max:6_000_000},
 {re:/^\/v1\/budgets$/,perm:'write'},{re:/^\/v1\/expenses$/,perm:'write'},
 {re:/^\/v1\/royalties\/rules$/,perm:'write'},{re:/^\/v1\/royalties\/rules\/delete$/,perm:'write'},
 {re:/^\/v1\/royalties\/statements$/,perm:'write',manageIf:b=>b.finalize===true},
 {re:/^\/v1\/royalties\/payouts$/,perm:'manage'},
 {re:/^\/v1\/attendance$/,perm:'write'},
 {re:/^\/v1\/catalog$/,perm:'manage'},
 {re:/^\/v1\/labels$/,perm:'manage',noLabel:true},{re:/^\/v1\/families$/,perm:'manage',noLabel:true},
 {re:/^\/v1\/connectors$/,perm:'manage'},
 {re:/^\/v1\/rollups\/refresh$/,perm:'manage'},
 {re:/^\/v1\/alerts\/evaluate$/,perm:'manage',noLabel:true},
 {re:/^\/v1\/alerts\/feed\/[0-9a-f]{64}\/ack$/,perm:'write',noLabel:true,alertAck:true}
];
const fail=Object.freeze({error:'UNAVAILABLE',message:'Data is unavailable'});
export const actingUser=session=>String(session.subject).replace(/[^A-Za-z0-9._@+:-]/g,'_').slice(0,128);

async function readBody(req,max){
 const chunks=[];let size=0;
 for await(const chunk of req){size+=chunk.length;if(size>max) throw Object.assign(new Error('too large'),{status:413});chunks.push(chunk);}
 if(!/^application\/json/i.test(String(req.headers['content-type']||''))) throw Object.assign(new Error('json required'),{status:415});
 const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
 if(!value||typeof value!=='object'||Array.isArray(value)) throw Object.assign(new Error('object required'),{status:400});
 return value;
}

export function createConsoleRoutes(config,{fetchImpl,send,now=()=>Date.now()}){
 const writeToken=config.engineWriteToken;
 const qr=config.qrSecret&&config.appOrigin?createQrIssuer({secret:config.qrSecret,origin:config.appOrigin+'/',now}):null;
 const scanLimiter=new Map();
 const perms=session=>ROLE_PERMISSIONS[session.role]||ROLE_PERMISSIONS.team_member;
 const labelAllowed=(session,labelId)=>typeof labelId==='string'&&(session.labels==='*'||session.labels.includes(labelId));

 async function engine(path,{method='GET',body,session,token=writeToken,timeout=method==='GET'?15000:120000}={}){
  const headers={authorization:'Bearer '+token,accept:'application/json'};
  if(body!==undefined) headers['content-type']='application/json';
  if(session) headers['x-acting-user']=actingUser(session);
  const signal=AbortSignal.timeout(timeout);
  const response=await fetchImpl(new URL(path,config.engineOrigin),{method,redirect:'error',signal,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const data=await readJson(response,{maxBytes:5_000_000,signal}).catch(()=>null);
  return {status:response.status,data};
 }
 // Engine validation messages (4xx) are user-facing; server errors are never passed through.
 function relay(res,{status,data}){
  if(status>=500||!data||typeof data!=='object') return send(res,502,fail);
  return send(res,status,data);
 }
 const notConfigured=res=>send(res,503,{error:'NOT_CONFIGURED',message:'Write access is not configured. Set ENGINE_WRITE_API_KEY on the Command Center and ENGINE_CONSOLE_KEY (same value) on the engine.'});

 async function write(req,res,url,session){
  const path=url.pathname.slice(4);
  const route=WRITE_ROUTES.find(r=>r.re.test(path));
  if(!route||url.search) return send(res,404,fail);
  if(!writeToken) return notConfigured(res);
  let body;try{body=await readBody(req,route.max||65536);}catch(e){return send(res,e.status||400,{error:'BAD_REQUEST',message:'Invalid request body'});}
  const p=perms(session);
  if(!p[route.perm]||(route.manageIf?.(body)&&!p.manage)) return send(res,403,{error:'FORBIDDEN',message:'Your role does not allow this action'});
  if(!route.noLabel&&!labelAllowed(session,body.labelId)) return send(res,403,{error:'FORBIDDEN',message:'Label access denied'});
  if(route.noLabel&&route.perm==='manage'&&session.labels!=='*') return send(res,403,{error:'FORBIDDEN',message:'Requires access to all labels'});
  if(route.alertAck&&session.labels!=='*'){
   const fp=path.split('/')[4];
   const feed=await engine('/v1/alerts/feed?'+new URLSearchParams({labelIds:session.labels.join(','),status:'all',limit:'1000'}),{token:config.engineToken});
   if(!feed.data?.alerts?.some(a=>a.fingerprint===fp)) return send(res,404,fail);
  }
  try{return relay(res,await engine(path,{method:'POST',body,session}));}catch{return send(res,502,fail);}
 }

 async function admin(req,res,url,session){
  if(!perms(session).manage||session.labels!=='*') return send(res,403,{error:'FORBIDDEN',message:'Administrators only'});
  if(!writeToken) return notConfigured(res);
  const userRoute=/^\/api\/admin\/users(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname);
  try{
   if(userRoute&&req.method==='GET'&&!userRoute[1]){
    const r=await engine('/v1/accounts');if(r.status!==200) return relay(res,r);
    return send(res,200,{accounts:r.data.accounts,localAdmin:config.adminPassword?{username:config.adminUser,role:'tenant_admin',labels:'all'}:null,oidc:Boolean(config.oidc)});
   }
   if(req.method!=='POST') return send(res,405,fail);
   let body;try{body=await readBody(req,65536);}catch(e){return send(res,e.status||400,{error:'BAD_REQUEST',message:'Invalid request body'});}
   if(userRoute) return relay(res,await engine(userRoute[1]?'/v1/accounts/'+userRoute[1]:'/v1/accounts',{method:'POST',body,session}));
   if(url.pathname==='/api/admin/demo-data') return relay(res,await engine('/v1/admin/demo-data',{method:'POST',body:{},session}));
   if(url.pathname==='/api/admin/demo-data/remove') return relay(res,await engine('/v1/admin/demo-data/remove',{method:'POST',body:{},session}));
   return send(res,404,fail);
  }catch{return send(res,502,fail);}
 }

 async function issueQr(req,res,session){
  if(!qr) return send(res,503,{error:'NOT_CONFIGURED',message:'QR campaign links are off. Set QR_SIGNING_SECRET (32+ characters) and APP_ORIGIN on the Command Center.'});
  if(!perms(session).write) return send(res,403,{error:'FORBIDDEN',message:'Your role does not allow this action'});
  let body;try{body=await readBody(req,4096);}catch(e){return send(res,e.status||400,{error:'BAD_REQUEST',message:'Invalid request body'});}
  if(!labelAllowed(session,body.labelId)) return send(res,403,{error:'FORBIDDEN',message:'Label access denied'});
  const hours=Number(body.expiresInHours||24);
  if(!(hours>0&&hours<=24)) return send(res,400,{error:'BAD_REQUEST',message:'expiresInHours must be 1–24'});
  try{const url=qr.issue({labelId:body.labelId,eventId:body.eventId,campaignId:body.campaignId,expiresAtMs:now()+Math.floor(hours*3600000)});
   return send(res,200,{url,expiresAtMs:now()+Math.floor(hours*3600000)});}
  catch{return send(res,400,{error:'BAD_REQUEST',message:'labelId, eventId and campaignId must be 8–128 letters, digits, hyphens or underscores'});}
 }

 /** Public QR landing: verifies the signed campaign link and records one deduplicated, unverified scan aggregate. */
 async function scan(req,res,token,client){
  const html=(status,title,text)=>{res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
   res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title><main><h1>'+title+'</h1><p>'+text+'</p></main>');};
  const data=qr?.verify(token);
  if(!data) return html(404,'Link not valid','This campaign link is invalid or has expired.');
  const t=now(),day=new Date(t).toISOString().slice(0,10),key=client+'\0'+token;
  for(const [k,v] of scanLimiter) if(t-v>86400000) scanLimiter.delete(k);
  if(scanLimiter.size>50000) scanLimiter.clear();
  if(writeToken&&!scanLimiter.has(key)){
   scanLimiter.set(key,t);
   const {createHash}=await import('node:crypto');
   const externalId='qr:'+createHash('sha256').update([token,client,day].join('\0')).digest('hex').slice(0,40);
   await engine('/v1/ingest',{method:'POST',body:{source:'qr-campaign',labelId:data.labelId,facts:[{externalId,type:'attendance',occurredAt:new Date(t).toISOString(),quantity:1,
    channel:'qr',metadata:{qrScan:true,eventId:data.eventId,campaignId:data.campaignId,verified:false}}]}}).catch(()=>null);
  }
  return html(200,'Thanks for scanning','Your scan for this event was counted anonymously. No personal information is stored.');
 }

 return Object.freeze({write,admin,issueQr,scan,writeConfigured:Boolean(writeToken),qrConfigured:Boolean(qr),perms,
  /** Engine-backed account sign-in: verifies the password through the engine without creating an engine session. */
  async verifyAccount(email,password){
   if(!writeToken) return null;
   const r=await engine('/v1/accounts/verify',{method:'POST',body:{email,password},timeout:15000});
   return r.status===200&&r.data?.account?r.data.account:null;
  },
  /** Re-check engine accounts at most once a minute so disabled or re-scoped users lose their session promptly. */
  accountGuard:(()=>{let cache=null,at=0;
   return async session=>{
    if(session.method!=='account') return true;
    if(!cache||now()-at>60000){const r=await engine('/v1/accounts').catch(()=>null);if(r?.status===200){cache=new Map(r.data.accounts.map(a=>[a.id,a]));at=now();}}
    const a=cache?.get(session.accountId);
    if(!a||a.disabled||a.role!==session.role) return false;
    const labels=a.role==='tenant_admin'?'*':a.labelIds;
    return labels==='*'?session.labels==='*':Array.isArray(session.labels)&&session.labels.length===labels.length&&labels.every(l=>session.labels.includes(l));
   };})()
 });
}
