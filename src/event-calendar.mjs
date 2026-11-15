import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
export {projectCalendarEvent,listCalendarEvents,projectPublicEvent} from './event-calendar-core.mjs';
const id=/^[A-Za-z0-9_-]{8,128}$/;
/** Signed public campaign link, with no attendee identity or private location. */
export function createQrIssuer({secret,origin,now=()=>Date.now()}){
 if(!Buffer.isBuffer(secret)||secret.length<32) throw new Error('Invalid signing key');
 const site=new URL(origin);
 if(site.protocol!=='https:'||site.username||site.password||site.search||site.hash||site.pathname!=='/') throw new Error('Invalid origin');
 const mac=body=>createHmac('sha256',secret).update(body).digest();
 return Object.freeze({
  issue({labelId,eventId,campaignId,expiresAtMs}){
   if(![labelId,eventId,campaignId].every(x=>typeof x==='string'&&id.test(x))||
     !Number.isSafeInteger(expiresAtMs)||expiresAtMs<=now()||expiresAtMs>now()+86400000) throw new Error('Invalid campaign');
   const payload={labelId,eventId,campaignId,expiresAtMs,nonce:randomBytes(16).toString('base64url')};
   const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
   return new URL('/q/'+body+'.'+mac(body).toString('base64url'),site).href;
  },
  verify(token){
   if(typeof token!=='string'||token.length>2048) return null;
   const parts=token.split('.');if(parts.length!==2||!parts.every(x=>/^[A-Za-z0-9_-]+$/.test(x))) return null;
   try{
    const signature=Buffer.from(parts[1],'base64url'),expected=mac(parts[0]);
    // Require canonical base64url so trailing-bit variants of a signature are not accepted as distinct tokens.
    if(signature.toString('base64url')!==parts[1]||Buffer.from(parts[0],'base64url').toString('base64url')!==parts[0]) return null;
    if(signature.length!==expected.length||!timingSafeEqual(signature,expected)) return null;
    const data=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
    if(![data.labelId,data.eventId,data.campaignId].every(x=>typeof x==='string'&&id.test(x))||
      !Number.isSafeInteger(data.expiresAtMs)||now()>=data.expiresAtMs) return null;
    return Object.freeze({labelId:data.labelId,eventId:data.eventId,campaignId:data.campaignId});
   }catch{return null;}
  }
 });
}
