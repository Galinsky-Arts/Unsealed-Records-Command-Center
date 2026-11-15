import {createHmac,hkdfSync,randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';

const b64=value=>Buffer.from(value).toString('base64url');
const SESSION_COOKIE='__Host-urc_session';
export const sessionCookieName=SESSION_COOKIE;

/** Derive independent keys from SESSION_SECRET so one value never serves two purposes. */
export function deriveKeys(secret){
 if(typeof secret!=='string'||secret.length<32) throw new Error('Invalid configuration: SESSION_SECRET');
 const derive=info=>Buffer.from(hkdfSync('sha256',Buffer.from(secret,'utf8'),Buffer.alloc(0),info,32));
 return Object.freeze({mac:derive('urc-session-mac-v1'),seal:derive('urc-oidc-pending-v1')});
}

/** Store only an scrypt digest of the configured admin password in memory. */
export function createPasswordVerifier(password){
 if(typeof password!=='string'||password.length<16||password.length>1024) throw new Error('Invalid configuration: ADMIN_PASSWORD');
 const salt=randomBytes(16),params={N:16384,r:8,p:1,maxmem:64*1024*1024};
 const digest=scryptSync(password.normalize('NFC'),salt,32,params);
 return candidate=>{
  if(typeof candidate!=='string'||candidate.length>1024) {scryptSync('x',salt,32,params);return false;}
  return timingSafeEqual(scryptSync(candidate.normalize('NFC'),salt,32,params),digest);
 };
}

export function constantTimeEqualString(a,b){
 const left=createHmac('sha256','cmp').update(String(a)).digest(),right=createHmac('sha256','cmp').update(String(b)).digest();
 return timingSafeEqual(left,right)&&String(a)===String(b);
}

export function issueSession(keys,{subject,method,labels,nowMs,ttlMs}){
 const payload=b64(JSON.stringify({v:1,sub:subject,m:method,l:labels,iat:nowMs,exp:nowMs+ttlMs,n:b64(randomBytes(9))}));
 return payload+'.'+createHmac('sha256',keys.mac).update(payload).digest('base64url');
}

export function readSession(keys,value,nowMs){
 if(typeof value!=='string'||value.length>3800||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) return null;
 const [payload,mac]=value.split('.');
 const expected=createHmac('sha256',keys.mac).update(payload).digest();
 const given=Buffer.from(mac,'base64url');
 if(given.length!==expected.length||!timingSafeEqual(given,expected)) return null;
 try{
  const s=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
  if(s.v!==1||typeof s.sub!=='string'||!['local','oidc'].includes(s.m)||!Number.isSafeInteger(s.exp)||!Number.isSafeInteger(s.iat)||
   s.exp<=nowMs||s.iat>nowMs+30000||!(s.l==='*'||(Array.isArray(s.l)&&s.l.every(x=>typeof x==='string')))) return null;
  return Object.freeze({subject:s.sub,method:s.m,labels:s.l,expiresAtMs:s.exp});
 }catch{return null;}
}

export function cookieHeader(name,value,maxAgeSeconds,{secure=true}={}){
 return `${name}=${value}; Path=/; HttpOnly;${secure?' Secure;':''} SameSite=Lax; Max-Age=${Math.max(0,Math.floor(maxAgeSeconds))}`;
}

/** Sliding-window failure counter keyed by client and by account; bounded memory. */
export function createLoginLimiter({windowMs=15*60*1000,maxPerClient=5,maxPerAccount=20,maxKeys=10000,now=()=>Date.now()}={}){
 const buckets=new Map();
 const prune=t=>{for(const [k,v] of buckets){const kept=v.filter(x=>t-x<windowMs);if(kept.length)buckets.set(k,kept);else buckets.delete(k);}};
 const count=(key,t)=>(buckets.get(key)||[]).filter(x=>t-x<windowMs).length;
 return Object.freeze({
  blocked(client,account){
   const t=now();
   const c=count('c:'+client,t),a=count('a:'+account,t);
   if(c>=maxPerClient||a>=maxPerAccount){
    const oldest=Math.min(...[...(buckets.get('c:'+client)||[]),...(buckets.get('a:'+account)||[])].filter(x=>t-x<windowMs));
    return Math.max(1,Math.ceil((oldest+windowMs-t)/1000));
   }
   return 0;
  },
  fail(client,account){
   const t=now();
   if(buckets.size>=maxKeys) prune(t);
   if(buckets.size>=maxKeys) buckets.clear();
   for(const key of ['c:'+client,'a:'+account]){const list=buckets.get(key)||[];list.push(t);buckets.set(key,list.slice(-50));}
  },
  succeed(client){buckets.delete('c:'+client);}
 });
}
