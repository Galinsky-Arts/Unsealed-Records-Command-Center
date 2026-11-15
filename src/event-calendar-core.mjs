const id=/^[A-Za-z0-9_-]{8,128}$/;
const fail=()=>{throw new Error('Invalid public event');};
/** Public-only calendar projection. Source ownership/publish approval are server responsibilities. */
export function projectCalendarEvent(x,{requestedLabelId,allowedHosts=[],nowMs=Date.now()}={}){
 if(typeof requestedLabelId!=='string'||!id.test(requestedLabelId)||!x||typeof x!=='object'||Array.isArray(x)||
  x.labelId!==requestedLabelId||x.ownerVerified!==true||x.publishApproved!==true||
  !id.test(x.eventId||'')||typeof x.title!=='string'||x.title.trim().length<2||x.title.length>120||
  typeof x.startsAt!=='string'||typeof x.endsAt!=='string'||
  !Number.isFinite(Date.parse(x.startsAt))||!Number.isFinite(Date.parse(x.endsAt))||
  Date.parse(x.endsAt)<=Date.parse(x.startsAt)||!['scheduled','cancelled','completed'].includes(x.status)||
  x.privateAttendees!==undefined||x.venuePrivateDetails!==undefined||
  !x.source||!Number.isSafeInteger(x.source.revision)||x.source.revision<0||
  !Number.isSafeInteger(x.source.observedAtMs)||x.source.observedAtMs>nowMs+30000) return fail();
 let url;
 try{url=new URL(x.publicUrl);}catch{return fail();}
 if(url.protocol!=='https:'||url.username||url.password||url.hash||
  !allowedHosts.includes(url.hostname)||url.search) return fail();
 return Object.freeze({labelId:x.labelId,eventId:x.eventId,title:x.title.trim(),startsAt:x.startsAt,
  endsAt:x.endsAt,status:x.status,publicUrl:url.href,
  source:Object.freeze({revision:x.source.revision,observedAtMs:x.source.observedAtMs})});
}

export function listCalendarEvents(rows,options){
 if(!Array.isArray(rows)||rows.length>1000) return fail();
 const latest=new Map();
 for(const raw of rows){
  const event=projectCalendarEvent(raw,options),previous=latest.get(event.eventId);
  if(previous&&event.source.revision===previous.source.revision&&JSON.stringify(event)!==JSON.stringify(previous)) return fail();
  if(!previous||event.source.revision>previous.source.revision) latest.set(event.eventId,event);
 }
 return Object.freeze([...latest.values()].sort((a,b)=>a.startsAt.localeCompare(b.startsAt)));
}

/** Legacy narrow projection. */
export function projectPublicEvent(x){
 if(!x||x.ownerVerified!==true||x.publishApproved!==true||!id.test(x.eventId||'')||
  typeof x.title!=='string'||x.title.length<2||x.title.length>120||
  !Number.isFinite(Date.parse(x.startsAt))||typeof x.publicUrl!=='string'||!x.publicUrl.startsWith('https://')||
  x.privateAttendees!==undefined||x.venuePrivateDetails!==undefined) return fail();
 return Object.freeze({eventId:x.eventId,title:x.title,startsAt:x.startsAt,publicUrl:x.publicUrl});
}
