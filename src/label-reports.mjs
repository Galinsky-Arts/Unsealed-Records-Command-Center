import {projectLabelCatalog} from './catalog-identity.mjs';
import {selectStreamingRecords} from './streaming-insights.mjs';
import {summarizeSalesEvents} from './storefront-sales.mjs';
import {projectTooLostDetail} from './toolost-statement.mjs';
import {projectSceneSignalAggregate} from './scenesignal-session.mjs';
import {projectSourceObservation} from './source-health.mjs';
import {projectStemsReceipt} from './stems-commerce.mjs';
import {listCalendarEvents} from './event-calendar-core.mjs';

export const ENGINE_SOURCE='music-operations-engine';
export const LABEL_REPORTS=Object.freeze(['catalog','streams','sales','toolost','scenesignal','health','events','stems','artist','trackzero']);
export const REPORT_TITLES=Object.freeze({catalog:'Catalog identity',streams:'Streaming insights',sales:'Storefront sales',toolost:'TooLost statements',
 scenesignal:'SceneSignal sessions',health:'Source health',events:'Event calendar',stems:'Stems White Label commerce',artist:'Artist royalties',trackzero:'TrackZero creator contributions'});
const labelPattern=/^[A-Za-z0-9_-]{8,128}$/;
export const reportableLabel=labelId=>typeof labelId==='string'&&labelPattern.test(labelId);

/**
 * Validate an engine label-report payload with the report module's own projection and derive an honest state:
 * live, cached (older than freshness, or last good result after a failed refresh), awaiting (no producer data),
 * synthetic/mixed (source-marked), not-applicable, or unavailable (nothing valid to show).
 */
export function projectLabelReport(name,payload,{labelId,nowMs=Date.now(),freshnessMs=48*3600000}={}){
 if(!payload||typeof payload!=='object'||payload.labelId!==labelId||payload.report!==name) throw new Error('Report does not match the selected label');
 if(payload.status==='not-applicable') return {state:'not-applicable',reason:payload.reason||null,data:null};
 const opts={requestedLabelId:labelId,nowMs};
 const aged=times=>times.length&&times.every(t=>nowMs-t>freshnessMs);
 switch(name){
  case 'catalog':{
   const releases=(payload.releases||[]).map(r=>projectLabelCatalog(r,{...opts,expectedSource:ENGINE_SOURCE}));
   if(!releases.length) return {state:'awaiting',data:{releases}};
   return {state:aged(releases.map(r=>r.source.observedAtMs))?'cached':'live',data:{releases,notReported:payload.notReported||[]}};
  }
  case 'streams':{
   const result=selectStreamingRecords(payload.records||[],{...opts,expectedSource:ENGINE_SOURCE,freshnessMs});
   const state={awaiting:'awaiting',synthetic:'synthetic',mixed:'mixed',cached:'cached',live:'live'}[result.availability];
   return {state,data:{...result,truncated:Boolean(payload.truncated)}};
  }
  case 'sales':{
   const summary=summarizeSalesEvents(payload.events||[],{...opts,expectedSource:ENGINE_SOURCE});
   const state=summary.availability==='observed'?(aged((payload.events||[]).map(e=>e.source.observedAtMs))?'cached':'live'):summary.availability;
   return {state,data:{summary,unattributedRefunds:payload.unattributedRefunds||[],truncated:Boolean(payload.truncated)}};
  }
  case 'toolost':{
   const statements=(payload.statements||[]).map(s=>projectTooLostDetail(s,opts));
   if(!statements.length) return {state:'awaiting',data:{statements}};
   return {state:statements.every(s=>s.source.kind==='synthetic')?'synthetic':'live',data:{statements,notReported:payload.notReported||[]}};
  }
  case 'scenesignal':{
   const sessions=(payload.sessions||[]).map(s=>projectSceneSignalAggregate(s,opts));
   if(!sessions.length) return {state:'awaiting',data:{sessions}};
   return {state:aged(sessions.map(s=>s.source.observedAtMs))?'cached':'live',data:{sessions}};
  }
  case 'health':{
   const observations=(payload.observations||[]).map(o=>projectSourceObservation(o,opts))
    .map(o=>({...o,stale:nowMs-o.observedAtMs>o.maxAgeMs}));
   if(!observations.length) return {state:'awaiting',data:{observations}};
   return {state:observations.some(o=>o.stale)?'cached':'live',data:{observations}};
  }
  case 'stems':{
   const receipts=(payload.receipts||[]).map(r=>projectStemsReceipt(r,opts));
   return {state:receipts.length?'live':'awaiting',reason:payload.reason||null,data:{receipts}};
  }
  case 'events':{
   const events=listCalendarEvents(payload.events||[],{...opts,allowedHosts:[]});
   return {state:events.length?'live':'awaiting',reason:payload.reason||null,data:{events}};
  }
  case 'artist':
   if((payload.statements||[]).length) throw new Error('Artist allocations require an artist-scoped session');
   return {state:'awaiting',reason:payload.reason||null,data:{statements:[]}};
  case 'trackzero':
   if((payload.events||[]).length) throw new Error('Creator contributions require a creator-scoped session');
   return {state:'awaiting',reason:payload.reason||null,data:null};
  default: throw new Error('Unknown report');
 }
}

/** Loads every label report; a failed refresh keeps the last valid result and labels it cached. */
export function createLabelReportsLoader({fetchImpl=fetch,now=()=>Date.now(),timeoutMs=15000}={}){
 const lastGood=new Map();let generation=0;
 return Object.freeze({
  async load(labelId){
   if(!reportableLabel(labelId)) throw new Error('Label id is not supported by label report routes');
   const current=++generation;
   const results=await Promise.all(LABEL_REPORTS.map(async name=>{
    const key=labelId+'\0'+name;
    try{
     const response=await fetchImpl('/api/labels/'+encodeURIComponent(labelId)+'/reports/'+name,
      {method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{accept:'application/json'},signal:AbortSignal.timeout?.(timeoutMs)});
     if(!response.ok) throw new Error('Report unavailable ('+response.status+')');
     const result={name,...projectLabelReport(name,await response.json(),{labelId,nowMs:now()})};
     lastGood.set(key,result);return result;
    }catch(error){
     const previous=lastGood.get(key);
     return previous?{...previous,state:'cached',error:'Refresh failed; showing the last valid report'}:{name,state:'unavailable',error:error?.message||'Report unavailable',data:null};
    }
   }));
   if(current!==generation) throw new Error('Label report request superseded');
   return Object.freeze(Object.fromEntries(results.map(r=>[r.name,r])));
  },
  cancel(){generation++;}
 });
}
