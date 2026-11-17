import React,{useCallback,useEffect,useRef,useState} from "react";
import {formatInteger} from "./operations.js";

/* Shared helpers ------------------------------------------------------------------------------- */
export async function api(path,{method="GET",body}={}){
  const r=await fetch(path,{method,credentials:"same-origin",cache:"no-store",headers:body!==undefined?{"content-type":"application/json"}:{},body:body!==undefined?JSON.stringify(body):undefined});
  const data=await r.json().catch(()=>null);
  if(!r.ok){const e=new Error(data?.message||data?.error||("Request failed ("+r.status+")"));e.status=r.status;e.data=data;throw e;}
  return data;
}
const EXP={JPY:0,KRW:0,KWD:3};
export function money(minor,currency="USD"){
  const exp=EXP[currency]??2;let v=BigInt(minor||0);const neg=v<0n;if(neg)v=-v;
  const s=v.toString().padStart(exp+1,"0"),whole=s.slice(0,s.length-exp)||"0",frac=exp?"."+s.slice(-exp):"";
  return (neg?"−":"")+currency+" "+new Intl.NumberFormat("en-US").format(BigInt(whole))+frac;
}
export function toMinor(text,currency="USD"){
  const exp=EXP[currency]??2,m=/^\s*(\d+)(?:\.(\d+))?\s*$/.exec(String(text||""));
  if(!m||(m[2]||"").length>exp)return null;
  return (BigInt(m[1])*10n**BigInt(exp)+BigInt((m[2]||"").padEnd(exp,"0")||"0")).toString();
}
export const labelOf=scope=>scope.startsWith("label:")?scope.slice(6):null;
export function scopeParams(scope){if(scope==="all")return{};const [k,...rest]=scope.split(":");return{[k+"Id"]:rest.join(":")};}
const q=(scope,extra={})=>{const p=new URLSearchParams({...scopeParams(scope),...Object.fromEntries(Object.entries(extra).filter(([,v])=>v!==undefined&&v!==null&&v!==""))}).toString();return p?"?"+p:"";};
const prevMonth=()=>{const d=new Date();d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()-1);return d.toISOString().slice(0,7);};
const thisMonth=()=>new Date().toISOString().slice(0,7);

/** Load a JSON engine route; a failed refresh keeps earlier data as "cached", never as live. */
export function useLoad(path,{interval=0}={}){
  const [state,setState]=useState({status:path?"loading":"idle",data:null,error:""});
  const latest=useRef(null),version=useRef(0);
  const load=useCallback(async()=>{
    if(!path)return;const v=++version.current;
    try{const data=await api(path);if(v!==version.current)return;latest.current=data;setState({status:"live",data,error:""});}
    catch(e){if(v!==version.current)return;setState({status:latest.current?"cached":"unavailable",data:latest.current,error:e.message});}
  },[path]);
  useEffect(()=>{latest.current=null;setState({status:path?"loading":"idle",data:null,error:""});load();
    if(!interval)return()=>{++version.current};const t=setInterval(load,interval);return()=>{++version.current;clearInterval(t)}},[path]);
  return {...state,reload:load};
}
const STATE_TEXT={live:"Live engine data",cached:"Cached — not current",awaiting:"Awaiting producer",synthetic:"Synthetic demo data",mixed:"Mixed live and synthetic",unavailable:"Unavailable",loading:"Loading",idle:"—"};
export function syntheticState(scope,menu){
  const labels=menu?.labels||[];if(!labels.length)return null;
  const ids=scope==="all"?labels.map(l=>l.id):scope.startsWith("family:")?(menu.families||[]).find(f=>"family:"+f.id===scope)?.labelIds||[]:[labelOf(scope)];
  const syn=ids.filter(id=>labels.find(l=>l.id===id)?.synthetic);
  return syn.length&&syn.length===ids.length?"synthetic":syn.length?"mixed":null;
}
/** Provenance badge: synthetic/mixed scope wins over live; empty live data reads as awaiting. */
export function Badge({status,empty,synthetic}){
  let s=status;if(s==="live"&&empty)s="awaiting";if((s==="live"||s==="awaiting"||s==="cached")&&synthetic)s=s==="cached"?"cached":synthetic;
  return <span className={"report-state "+s}>{STATE_TEXT[s]||s}</span>;
}
function Panel({title,overline,right,children,className=""}){return <section className={"panel full "+className}><div className="panel-header"><div>{overline&&<div className="overline">{overline}</div>}<h3>{title}</h3></div>{right}</div>{children}</section>}
function Msg({msg}){return msg?<p className={"form-msg "+(msg.ok?"ok":"err")} role="status">{msg.text}</p>:null}
function useAction(){const[msg,setMsg]=useState(null),[busy,setBusy]=useState(false);
  const run=async(fn,ok)=>{setBusy(true);setMsg(null);try{const r=await fn();setMsg({ok:true,text:typeof ok==="function"?ok(r):ok||"Saved."});return r;}catch(e){setMsg({ok:false,text:e.message});return null;}finally{setBusy(false)}};
  return {msg,busy,run,setMsg};}
function NeedLabel({what}){return <div className="panel empty"><h3>Choose a single label</h3><p>{what} works on one label at a time. Select a label in the menu above.</p></div>}
const canWrite=s=>s?.permissions?.write!==false&&s?.features?.write!==false;
const canManage=s=>Boolean(s?.permissions?.manage)&&s?.features?.write!==false;
function WriteHint({session}){if(session?.features?.write===false)return <p className="muted">Changes are disabled: the administrator has not configured ENGINE_WRITE_API_KEY on the Command Center.</p>;if(session&&!session.permissions?.write)return <p className="muted">Your role is read-only.</p>;return null}
function BarChart({series,label}){const max=series.reduce((m,x)=>x.value>m?x.value:m,1);
  return <svg className="bars" viewBox={"0 0 "+Math.max(series.length*14,140)+" 90"} preserveAspectRatio="none" role="img" aria-label={label}>{series.map((x,i)=><rect key={x.key} x={i*14+2} y={88-84*x.value/max} width="10" height={Math.max(84*x.value/max,0.5)} rx="2"><title>{x.key+": "+formatInteger(x.value)}</title></rect>)}</svg>}

/* Catalog ----------------------------------------------------------------------------------- */
export function CatalogScreen({scope,menu,session}){
  const[kind,setKind]=useState(""),[items,setItems]=useState([]),[cursor,setCursor]=useState(null),[status,setStatus]=useState("loading"),[err,setErr]=useState("");
  const syn=syntheticState(scope,menu);
  const fetchPage=async(c,reset)=>{try{const d=await api("/api/v1/catalog"+q(scope,{limit:100,cursor:c,kind}));setItems(x=>reset?d.items:[...x,...d.items]);setCursor(d.nextCursor);setStatus("live");setErr("")}catch(e){setStatus(items.length?"cached":"unavailable");setErr(e.message)}};
  useEffect(()=>{setItems([]);setCursor(null);setStatus("loading");fetchPage(null,true)},[scope,kind]);
  const unmapped=useLoad("/api/v1/catalog/unmapped-isrcs"+q(scope,{limit:50}));
  const labelName=id=>menu?.labels?.find(l=>l.id===id)?.name||id;
  return <>
    <Panel overline="CATALOG" title="Artists, releases and tracks" right={<Badge status={status} empty={!items.length} synthetic={syn}/>}>
      <div className="form-row"><label>Kind <select value={kind} onChange={e=>setKind(e.target.value)}><option value="">All</option><option value="artist">Artists</option><option value="release">Releases</option><option value="track">Tracks</option></select></label></div>
      {err&&<p className="muted">{err}</p>}
      <div className="table-wrap"><table><thead><tr><th>NAME</th><th>KIND</th><th>ISRC / UPC</th><th>LABEL</th></tr></thead><tbody>
        {items.length?items.map(i=><tr key={i.labelId+i.id}><td><b>{i.name}</b><small className="release-label">{i.id}</small></td><td>{i.kind}</td><td>{i.isrc||i.upc||"—"}</td><td>{labelName(i.labelId)}</td></tr>):<tr><td colSpan="4">{status==="loading"?"Loading…":"No catalog items for this scope."}</td></tr>}
      </tbody></table></div>
      {cursor&&<button className="refresh" onClick={()=>fetchPage(cursor,false)}>Load more</button>}
    </Panel>
    <Panel overline="MAPPING" title="ISRCs seen in reports but missing from the catalog" right={<Badge status={unmapped.status} empty={!unmapped.data?.items?.length} synthetic={syn}/>}>
      {unmapped.data?.items?.length?<div className="table-wrap"><table><thead><tr><th>ISRC</th><th>FACTS</th><th>SOURCES</th><th>LAST SEEN</th></tr></thead><tbody>{unmapped.data.items.map(u=><tr key={u.labelId+u.isrc}><td>{u.isrc}</td><td>{formatInteger(u.facts)}</td><td>{u.sources.join(", ")}</td><td>{u.lastSeenAt?.slice(0,10)}</td></tr>)}</tbody></table></div>:<p className="muted">Every reported ISRC maps to a catalog track.</p>}
    </Panel>
    {canManage(session)&&labelOf(scope)&&<CatalogForm labelId={labelOf(scope)} onSaved={()=>fetchPage(null,true)}/>}
  </>;
}
function CatalogForm({labelId,onSaved}){
  const[f,setF]=useState({kind:"track",id:"",name:"",artistId:"",releaseId:"",isrc:"",upc:""});const a=useAction();
  const set=k=>e=>setF({...f,[k]:e.target.value});
  const submit=e=>{e.preventDefault();const body={labelId,kind:f.kind,id:f.id.trim(),name:f.name.trim()};
    if(f.kind!=="artist")body.artistId=f.artistId.trim();if(f.kind==="track"){body.releaseId=f.releaseId.trim();if(f.isrc)body.isrc=f.isrc.trim();}if(f.kind==="release"&&f.upc)body.upc=f.upc.trim();
    a.run(()=>api("/api/v1/catalog",{method:"POST",body}),"Catalog item saved.").then(r=>r&&onSaved())};
  return <Panel overline="ADMIN" title="Add or update a catalog item"><form className="form-grid" onSubmit={submit}>
    <label>Kind<select value={f.kind} onChange={set("kind")}><option>artist</option><option>release</option><option>track</option></select></label>
    <label>Id<input required value={f.id} onChange={set("id")} placeholder="stable-id"/></label>
    <label>Name<input required value={f.name} onChange={set("name")}/></label>
    {f.kind!=="artist"&&<label>Artist id<input required value={f.artistId} onChange={set("artistId")}/></label>}
    {f.kind==="track"&&<><label>Release id<input required value={f.releaseId} onChange={set("releaseId")}/></label><label>ISRC<input value={f.isrc} onChange={set("isrc")}/></label></>}
    {f.kind==="release"&&<label>UPC<input value={f.upc} onChange={set("upc")}/></label>}
    <button className="refresh" disabled={a.busy}>Save</button></form><Msg msg={a.msg}/></Panel>;
}

/* Streams and sales from daily rollups --------------------------------------------------------- */
function useRollups(scope){return useLoad("/api/v1/rollups/daily"+q(scope,{limit:5000}),{interval:60000});}
export function StreamsScreen({scope,menu}){
  const r=useRollups(scope),syn=syntheticState(scope,menu);
  const rows=(r.data?.rollups||[]).filter(x=>x.type==="stream");
  const byDay=new Map(),bySource=new Map();
  for(const x of rows){byDay.set(x.date,(byDay.get(x.date)||0)+Number(x.quantity));bySource.set(x.source,(bySource.get(x.source)||0n)+BigInt(x.quantity));}
  const days=[...byDay].sort((a,b)=>a[0].localeCompare(b[0])).slice(-60).map(([key,value])=>({key,value}));
  const total=[...bySource.values()].reduce((a,b)=>a+b,0n);
  return <>
    <Panel overline="STREAMING" title={formatInteger(total)+" streams in daily rollups"} right={<Badge status={r.status} empty={!rows.length} synthetic={syn}/>}>
      {rows.length?<><BarChart series={days} label="Daily streams"/><div className="axis"><span>{days[0]?.key}</span><span>{days.at(-1)?.key}</span></div>
        <p className="muted">{r.data?.materialized?"Served from stored rollups refreshed "+(r.data.refreshedAt||"").slice(0,16).replace("T"," ")+" UTC.":"Computed on demand by the engine."} Shared activities are counted once.</p></>
        :<p className="muted">No streaming reports yet. Upload Spotify for Artists, Apple Music or YouTube exports on the Imports screen.</p>}
      {r.error&&r.status==="cached"&&<p className="muted">{r.error}</p>}
    </Panel>
    <Panel overline="BY SOURCE" title="Streams by provider"><div className="table-wrap"><table><thead><tr><th>SOURCE</th><th>STREAMS</th><th>SHARE</th></tr></thead><tbody>
      {[...bySource].sort((a,b)=>a[1]<b[1]?1:-1).map(([s,v])=><tr key={s}><td><b>{s}</b></td><td>{formatInteger(v)}</td><td>{total?(Number(v*1000n/total)/10).toFixed(1)+"%":"—"}</td></tr>)}
      {!bySource.size&&<tr><td colSpan="3">Awaiting streaming data.</td></tr>}</tbody></table></div></Panel>
  </>;
}
export function SalesScreen({scope,menu}){
  const r=useRollups(scope),syn=syntheticState(scope,menu);
  const dist=useLoad("/api/v1/distributor/rows"+q(scope,{limit:200}));
  const recon=useLoad("/api/v1/distributor/reconciliations"+q(scope,{limit:100}));
  const rows=(r.data?.rollups||[]).filter(x=>x.type==="sale"||x.type==="refund"||x.type==="royalty");
  const cur=new Map();
  for(const x of rows){const k=x.currency.trim(),c=cur.get(k)||{sale:0n,refund:0n,royalty:0n,orders:0n};c[x.type]+=BigInt(x.amountMinor);if(x.type==="sale")c.orders+=BigInt(x.facts);cur.set(k,c);}
  return <>
    <Panel overline="SALES" title="Gross sales, refunds and royalties by currency" right={<Badge status={r.status} empty={!rows.length} synthetic={syn}/>}>
      {cur.size?<div className="table-wrap"><table><thead><tr><th>CURRENCY</th><th>SALES</th><th>REFUNDS</th><th>NET OF REFUNDS</th><th>ROYALTY FACTS</th><th>ORDERS</th></tr></thead><tbody>
        {[...cur].map(([c,v])=><tr key={c}><td><b>{c}</b></td><td>{money(v.sale,c)}</td><td>{money(v.refund,c)}</td><td>{money(v.sale-v.refund,c)}</td><td>{money(v.royalty,c)}</td><td>{formatInteger(v.orders)}</td></tr>)}</tbody></table></div>
        :<p className="muted">No sales reported for this scope. Stems orders can be uploaded on the Imports screen.</p>}
      <p className="muted">Currencies are never combined. Settlement status is shown per statement on the Royalties screen.</p>
    </Panel>
    <Panel overline="DISTRIBUTOR" title="Imported distributor statement lines (TooLost and others)" right={<Badge status={dist.status} empty={!dist.data?.rows?.length} synthetic={syn}/>}>
      {dist.data?.rows?.length?<div className="table-wrap"><table><thead><tr><th>DATE</th><th>ISRC</th><th>STATEMENT</th><th>GROSS</th><th>FEES</th><th>NET</th><th>STATUS</th></tr></thead><tbody>
        {dist.data.rows.map(x=><tr key={x.id}><td>{String(x.occurredAt).slice(0,10)}</td><td>{x.isrc}</td><td>{x.statementId}</td><td>{money(x.grossMinor,x.currency)}</td><td>{money(x.feesMinor,x.currency)}</td><td>{money(x.netMinor,x.currency)}</td><td>{x.payoutStatus||x.providerStatus}</td></tr>)}</tbody></table></div>
        :<p className="muted">No distributor statements imported.</p>}
    </Panel>
    <Panel overline="SETTLEMENT" title="Reconciled settlements" right={<Badge status={recon.status} empty={!recon.data?.reconciliations?.length} synthetic={syn}/>}>
      {recon.data?.reconciliations?.length?<ul className="plain-list">{recon.data.reconciliations.map(x=><li key={x.settlementId}><b>{x.settlementId}</b> · {money(x.providerMinor,x.currency)} · invoice {x.invoiceId} · bank {x.bankTransactionId}</li>)}</ul>:<p className="muted">No settlements reconciled yet.</p>}
    </Panel>
  </>;
}

/* Events, attendance and QR campaigns ----------------------------------------------------------- */
export function EventsScreen({scope,menu,session,summary}){
  const labelId=labelOf(scope),syn=syntheticState(scope,menu);
  const att=useLoad(labelId?"/api/v1/attendance?labelId="+encodeURIComponent(labelId)+"&limit=200":null);
  const[f,setF]=useState({eventId:"",sessionId:"main",sourceReceiptId:"",occurredAt:"",attendeeCount:""});const a=useAction();
  const[qf,setQf]=useState({eventId:"",campaignId:"",expiresInHours:"24"});const qa=useAction();const[link,setLink]=useState(null);
  const set=k=>e=>setF({...f,[k]:e.target.value}),setq=k=>e=>setQf({...qf,[k]:e.target.value});
  return <>
    <section className="metrics"><div className="stat"><div className="stat-top"><span>Events recorded</span></div><div className="stat-value">{formatInteger(summary?.counts?.events||0)}</div><small>Event facts in this scope</small></div>
      <div className="stat"><div className="stat-top"><span>Attendance</span></div><div className="stat-value">{formatInteger(summary?.counts?.attendees||0)}</div><small>Reported arrivals and QR scans</small></div></section>
    {!labelId?<NeedLabel what="Attendance check-in and QR campaigns"/>:<>
      <Panel overline="ATTENDANCE" title="Manual attendance reports" right={<Badge status={att.status} empty={!att.data?.reports?.length} synthetic={syn}/>}>
        {att.data?.reports?.length?<div className="table-wrap"><table><thead><tr><th>EVENT</th><th>SESSION</th><th>WHEN</th><th>ATTENDEES</th><th>RECEIPT</th></tr></thead><tbody>
          {att.data.reports.map(r=><tr key={r.id}><td><b>{r.eventId}</b></td><td>{r.sessionId}</td><td>{r.occurredAt.slice(0,16).replace("T"," ")}</td><td>{formatInteger(r.attendeeCount)}</td><td>{r.sourceReceiptId}</td></tr>)}</tbody></table></div>
          :<p className="muted">No attendance reported for this label.</p>}
        <p className="muted">Manual aggregates are attested counts, not verified tickets. No attendee identities are stored.</p>
        {canWrite(session)?<form className="form-grid" onSubmit={e=>{e.preventDefault();a.run(()=>api("/api/v1/attendance",{method:"POST",body:{labelId,eventId:f.eventId.trim(),sessionId:f.sessionId.trim(),sourceReceiptId:f.sourceReceiptId.trim()||("door-"+Date.now()),occurredAt:new Date(f.occurredAt).toISOString(),attendeeCount:f.attendeeCount}}),r=>r.duplicate?"Already recorded.":"Attendance recorded.").then(r=>r&&att.reload())}}>
          <label>Event id<input required value={f.eventId} onChange={set("eventId")}/></label><label>Session<input required value={f.sessionId} onChange={set("sessionId")}/></label>
          <label>Receipt / door sheet id<input value={f.sourceReceiptId} onChange={set("sourceReceiptId")} placeholder="auto"/></label>
          <label>When<input required type="datetime-local" value={f.occurredAt} onChange={set("occurredAt")}/></label><label>Attendees<input required inputMode="numeric" pattern="[0-9]+" value={f.attendeeCount} onChange={set("attendeeCount")}/></label>
          <button className="refresh" disabled={a.busy}>Record attendance</button></form>:<WriteHint session={session}/>}
        <Msg msg={a.msg}/>
      </Panel>
      <Panel overline="QR CAMPAIGNS" title="Signed QR campaign links">
        {session?.features?.qr===false?<p className="muted">QR campaign links are off. Set QR_SIGNING_SECRET and APP_ORIGIN on the Command Center to enable them.</p>:canWrite(session)?<>
          <form className="form-grid" onSubmit={e=>{e.preventDefault();setLink(null);qa.run(()=>api("/api/qr/issue",{method:"POST",body:{labelId,eventId:qf.eventId.trim(),campaignId:qf.campaignId.trim(),expiresInHours:Number(qf.expiresInHours)}}),"Link issued.").then(r=>r&&setLink(r))}}>
            <label>Event id<input required minLength="8" value={qf.eventId} onChange={setq("eventId")}/></label><label>Campaign id<input required minLength="8" value={qf.campaignId} onChange={setq("campaignId")}/></label>
            <label>Valid for (hours)<input type="number" min="1" max="24" value={qf.expiresInHours} onChange={setq("expiresInHours")}/></label><button className="refresh" disabled={qa.busy}>Issue link</button></form>
          <Msg msg={qa.msg}/>{link&&<p className="qr-link"><code>{link.url}</code><br/><small className="muted">Expires {new Date(link.expiresAtMs).toISOString().slice(0,16).replace("T"," ")} UTC. Encode it in any QR generator. Each device counts once per day as an unverified, anonymous scan (source qr-campaign).</small></p>}
        </>:<WriteHint session={session}/>}
      </Panel>
    </>}
  </>;
}

/* Royalties --------------------------------------------------------------------------------------- */
export function RoyaltiesScreen({scope,menu,session}){
  const labelId=labelOf(scope),syn=syntheticState(scope,menu);const[period,setPeriod]=useState(prevMonth());
  const preview=useLoad(labelId&&/^\d{4}-\d{2}$/.test(period)?"/api/v1/royalties/preview?labelId="+encodeURIComponent(labelId)+"&period="+period:null);
  const stored=useLoad("/api/v1/royalties/statements"+q(scope,{period}));
  const balances=useLoad("/api/v1/royalties/balances"+q(scope));
  const payouts=useLoad("/api/v1/royalties/payouts"+q(scope));
  const a=useAction();const refresh=()=>{preview.reload();stored.reload();balances.reload();payouts.reload();};
  if(!labelId)return <><NeedLabel what="Royalty statements"/><BalancesPanel balances={balances} syn={syn}/></>;
  const p=preview.data;
  const gen=finalize=>a.run(()=>api("/api/v1/royalties/statements",{method:"POST",body:{labelId,period,finalize}}),r=>(finalize?"Finalized ":"Draft saved for ")+r.statements.length+" payee statement(s)."+(r.conflicts.length?" "+r.conflicts.length+" finalized statement(s) differ from current data; post adjustments in a later period.":"")).then(r=>r&&refresh());
  return <>
    <Panel overline="ROYALTIES" title="Statement preview" right={<Badge status={preview.status} empty={!p?.statements?.length} synthetic={syn}/>}>
      <div className="form-row"><label>Period <input type="month" value={period} onChange={e=>setPeriod(e.target.value)}/></label>
        <a className="refresh" href={"/api/v1/exports/royalties.csv?labelId="+encodeURIComponent(labelId)+"&period="+period} download>Download statements CSV</a>
        {canWrite(session)&&<button className="refresh" disabled={a.busy} onClick={()=>gen(false)}>Save draft statements</button>}
        {canManage(session)&&<button className="refresh" disabled={a.busy} onClick={()=>{if(confirm("Finalize statements for "+period+"? Finalized statements cannot be changed."))gen(true)}}>Finalize</button>}</div>
      <Msg msg={a.msg}/>
      {p&&<p className="muted">{p.policy} Default rule: {p.defaultRule==="system-default"?"system default (50% primary artist / 50% label)":"label rule"}.</p>}
      {p?.revenue?.map(x=><p key={x.currency}><b>{x.currency}</b> revenue: recognized {money(x.recognizedMinor,x.currency)} · pending {money(x.pendingMinor,x.currency)}</p>)}
      {p?.statements?.length?<div className="table-wrap"><table><thead><tr><th>PAYEE</th><th>CURRENCY</th><th>RECOGNIZED</th><th>PENDING</th><th>LINES</th></tr></thead><tbody>
        {p.statements.map(s=><tr key={s.payeeId+s.currency}><td><b>{s.payeeName}</b><small className="release-label">{s.payeeId}</small></td><td>{s.currency}</td><td>{money(s.recognizedMinor,s.currency)}</td><td>{money(s.pendingMinor,s.currency)}</td>
          <td><details><summary>{s.lines.length} line(s)</summary><ul className="plain-list">{s.lines.map((l,i)=><li key={i}>{l.track||l.trackId||l.releaseId||"Unattributed"} · {l.kind} · {l.shareBps/100}% ({l.ruleScope}) · {money(l.recognizedMinor,s.currency)} recognized, {money(l.pendingMinor,s.currency)} pending</li>)}</ul></details></td></tr>)}</tbody></table></div>
        :preview.status==="live"&&<p className="muted">No revenue recorded for {period}.</p>}
    </Panel>
    <Panel overline="STORED" title={"Statements for "+period} right={<Badge status={stored.status} empty={!stored.data?.statements?.length} synthetic={syn}/>}>
      {stored.data?.statements?.length?<div className="table-wrap"><table><thead><tr><th>PAYEE</th><th>STATUS</th><th>RECOGNIZED</th><th>PENDING</th><th>GENERATED</th></tr></thead><tbody>
        {stored.data.statements.map(s=><tr key={s.id}><td><b>{s.payeeName}</b></td><td><span className={"pill "+s.status}>{s.status}</span></td><td>{money(s.recognizedMinor,s.currency)}</td><td>{money(s.pendingMinor,s.currency)}</td><td>{(s.finalizedAt||s.generatedAt||"").slice(0,16).replace("T"," ")}</td></tr>)}</tbody></table></div>:<p className="muted">No stored statements for this period.</p>}
    </Panel>
    <SplitRules labelId={labelId} session={session} onChange={refresh}/>
    <BalancesPanel balances={balances} syn={syn}/>
    <Payouts labelId={labelId} session={session} payouts={payouts} balances={balances} onChange={refresh}/>
  </>;
}
function BalancesPanel({balances,syn}){
  return <Panel overline="BALANCES" title="Payee balances (finalized statements − payouts)" right={<Badge status={balances.status} empty={!balances.data?.balances?.length} synthetic={syn}/>}>
    {balances.data?.balances?.length?<div className="table-wrap"><table><thead><tr><th>PAYEE</th><th>EARNED</th><th>PAID</th><th>BALANCE</th></tr></thead><tbody>
      {balances.data.balances.map(b=><tr key={b.labelId+b.payeeId+b.currency}><td><b>{b.payeeName}</b><small className="release-label">{b.payeeId} · {b.labelId}</small></td><td>{money(b.earnedMinor,b.currency)}</td><td>{money(b.paidMinor,b.currency)}</td><td>{money(b.balanceMinor,b.currency)}</td></tr>)}</tbody></table></div>:<p className="muted">No finalized statements yet.</p>}
  </Panel>;
}
function SplitRules({labelId,session,onChange}){
  const rules=useLoad("/api/v1/royalties/rules?labelId="+encodeURIComponent(labelId));const a=useAction();
  const[scopeKind,setScopeKind]=useState("label"),[scopeId,setScopeId]=useState(""),[rows,setRows]=useState([{payeeId:"@artist",name:"Primary artist",pct:"50"},{payeeId:"@label",name:"Label",pct:"50"}]);
  const total=rows.reduce((s,r)=>s+Math.round(Number(r.pct||0)*100),0);
  const save=e=>{e.preventDefault();a.run(()=>api("/api/v1/royalties/rules",{method:"POST",body:{labelId,scopeKind,scopeId:scopeKind==="label"?undefined:scopeId.trim(),splits:rows.map(r=>({payeeId:r.payeeId.trim(),name:r.name.trim()||r.payeeId.trim(),shareBps:Math.round(Number(r.pct)*100)}))}}),"Split rule saved.").then(r=>{if(r){rules.reload();onChange()}})};
  const del=r=>a.run(()=>api("/api/v1/royalties/rules/delete",{method:"POST",body:{labelId,scopeKind:r.scopeKind,scopeId:r.scopeId}}),"Rule removed.").then(x=>{if(x){rules.reload();onChange()}});
  return <Panel overline="SPLITS" title="Royalty split rules" right={<Badge status={rules.status} empty={false}/>}>
    <p className="muted">Precedence: track rule, then release rule, then label rule, then the system default (50% primary artist / 50% label). Use <code>@artist</code> for the line's catalog artist and <code>@label</code> for the label.</p>
    {rules.data?.rules?.length?<ul className="plain-list">{rules.data.rules.map(r=><li key={r.scopeKind+r.scopeId}><b>{r.scopeKind}{r.scopeId?": "+r.scopeId:""}</b> — {r.splits.map(s=>(s.name||s.payeeId)+" "+s.shareBps/100+"%").join(", ")}{r.note?" · "+r.note:""} {canWrite(session)&&<button className="link-btn" onClick={()=>del(r)}>remove</button>}</li>)}</ul>:<p className="muted">No rules configured; the system default applies.</p>}
    {canWrite(session)?<form className="form-grid" onSubmit={save}>
      <label>Applies to<select value={scopeKind} onChange={e=>setScopeKind(e.target.value)}><option value="label">Whole label</option><option value="release">Release</option><option value="track">Track</option></select></label>
      {scopeKind!=="label"&&<label>{scopeKind} id<input required value={scopeId} onChange={e=>setScopeId(e.target.value)}/></label>}
      {rows.map((r,i)=><div className="split-row" key={i}><input aria-label="Payee id" required value={r.payeeId} onChange={e=>setRows(rows.map((x,j)=>j===i?{...x,payeeId:e.target.value}:x))} placeholder="payee-id or @artist"/><input aria-label="Payee name" value={r.name} onChange={e=>setRows(rows.map((x,j)=>j===i?{...x,name:e.target.value}:x))} placeholder="Name"/><input aria-label="Share percent" required inputMode="decimal" value={r.pct} onChange={e=>setRows(rows.map((x,j)=>j===i?{...x,pct:e.target.value}:x))}/>%{rows.length>1&&<button type="button" className="link-btn" onClick={()=>setRows(rows.filter((_,j)=>j!==i))}>×</button>}</div>)}
      <div className="form-row"><button type="button" className="refresh" onClick={()=>setRows([...rows,{payeeId:"",name:"",pct:"0"}])}>Add payee</button><span className={total===10000?"muted":"warn"}>Total {total/100}%</span><button className="refresh" disabled={a.busy||total!==10000}>Save rule</button></div>
    </form>:<WriteHint session={session}/>}
    <Msg msg={a.msg}/>
  </Panel>;
}
function Payouts({labelId,session,payouts,balances,onChange}){
  const[f,setF]=useState({payeeId:"",currency:"USD",amount:"",reference:"",paidAt:""});const a=useAction();
  const owed=(balances.data?.balances||[]).filter(b=>b.labelId===labelId&&BigInt(b.balanceMinor)>0n);
  return <Panel overline="PAYOUTS" title="Recorded payouts" right={<Badge status={payouts.status} empty={!payouts.data?.payouts?.length}/>}>
    {payouts.data?.payouts?.length?<ul className="plain-list">{payouts.data.payouts.map(x=><li key={x.id}><b>{money(x.amountMinor,x.currency)}</b> to {x.payeeId} · {x.reference} · {x.paidAt.slice(0,10)}</li>)}</ul>:<p className="muted">No payouts recorded.</p>}
    {canManage(session)?<form className="form-grid" onSubmit={e=>{e.preventDefault();const minor=toMinor(f.amount,f.currency);if(!minor){a.setMsg({ok:false,text:"Enter a valid amount."});return;}
      a.run(()=>api("/api/v1/royalties/payouts",{method:"POST",body:{labelId,payeeId:f.payeeId,currency:f.currency,amountMinor:minor,reference:f.reference.trim(),paidAt:f.paidAt?new Date(f.paidAt).toISOString():undefined}}),"Payout recorded.").then(r=>r&&onChange())}}>
      <label>Payee<select required value={f.payeeId+"|"+f.currency} onChange={e=>{const[p,c]=e.target.value.split("|");setF({...f,payeeId:p,currency:c||"USD"})}}><option value="|USD">Choose…</option>{owed.map(b=><option key={b.payeeId+b.currency} value={b.payeeId+"|"+b.currency}>{b.payeeName} — {money(b.balanceMinor,b.currency)} owed</option>)}</select></label>
      <label>Amount ({f.currency})<input required inputMode="decimal" value={f.amount} onChange={e=>setF({...f,amount:e.target.value})}/></label>
      <label>Reference<input required value={f.reference} onChange={e=>setF({...f,reference:e.target.value})} placeholder="Bank / PayPal reference"/></label>
      <label>Paid on<input type="date" value={f.paidAt} onChange={e=>setF({...f,paidAt:e.target.value})}/></label>
      <button className="refresh" disabled={a.busy||!f.payeeId}>Record payout</button></form>:<p className="muted">Recording payouts requires an administrator.</p>}
    <Msg msg={a.msg}/><p className="muted">Recording a payout is bookkeeping evidence only; no money is moved.</p>
  </Panel>;
}

/* Budgets ---------------------------------------------------------------------------------------- */
export function BudgetsScreen({scope,menu,session}){
  const labelId=labelOf(scope),syn=syntheticState(scope,menu);const[period,setPeriod]=useState("");
  const budgets=useLoad("/api/v1/budgets"+q(scope,{period}));const expenses=useLoad("/api/v1/expenses"+q(scope));
  const[b,setB]=useState({id:"",name:"",period:thisMonth(),category:"marketing",currency:"USD",amount:"",releaseId:""});const ba=useAction();
  const[x,setX]=useState({budgetId:"",occurredOn:new Date().toISOString().slice(0,10),amount:"",description:"",vendor:""});const xa=useAction();
  const list=budgets.data?.budgets||[];const reload=()=>{budgets.reload();expenses.reload()};
  return <>
    <Panel overline="BUDGETS" title="Budgets and spend" right={<Badge status={budgets.status} empty={!list.length} synthetic={syn}/>}>
      <div className="form-row"><label>Period <input type="month" value={period} onChange={e=>setPeriod(e.target.value)}/></label>{period&&<button className="link-btn" onClick={()=>setPeriod("")}>all periods</button>}</div>
      {list.length?<div className="table-wrap"><table><thead><tr><th>BUDGET</th><th>PERIOD</th><th>BUDGET</th><th>SPENT</th><th>REMAINING</th><th>USE</th></tr></thead><tbody>
        {list.map(x=><tr key={x.labelId+x.id}><td><b>{x.name}</b><small className="release-label">{x.category}{x.releaseId?" · "+x.releaseId:""}</small></td><td>{x.period}</td><td>{money(x.amountMinor,x.currency)}</td><td>{money(x.spentMinor,x.currency)}</td><td>{money(x.remainingMinor,x.currency)}</td>
          <td><div className={"meter "+x.status} title={(x.utilizationBps/100).toFixed(1)+"%"}><span style={{width:Math.min(100,x.utilizationBps/100)+"%"}}/></div><small>{(x.utilizationBps/100).toFixed(0)}% {x.status!=="ok"?"· "+x.status:""}</small></td></tr>)}</tbody></table></div>
        :<p className="muted">No budgets for this scope.</p>}
    </Panel>
    {labelId&&canWrite(session)&&<Panel overline="PLAN" title="Create or update a budget"><form className="form-grid" onSubmit={e=>{e.preventDefault();const minor=toMinor(b.amount,b.currency);if(!minor){ba.setMsg({ok:false,text:"Enter a valid amount."});return;}
      ba.run(()=>api("/api/v1/budgets",{method:"POST",body:{labelId,id:b.id.trim(),name:b.name.trim(),period:b.period,category:b.category.trim(),currency:b.currency,amountMinor:minor,releaseId:b.releaseId.trim()||undefined}}),"Budget saved.").then(r=>r&&reload())}}>
      <label>Id<input required value={b.id} onChange={e=>setB({...b,id:e.target.value})} placeholder="marketing-2026-11"/></label><label>Name<input required value={b.name} onChange={e=>setB({...b,name:e.target.value})}/></label>
      <label>Period<input required type="month" value={b.period} onChange={e=>setB({...b,period:e.target.value})}/></label><label>Category<input required value={b.category} onChange={e=>setB({...b,category:e.target.value})}/></label>
      <label>Currency<input required maxLength="3" value={b.currency} onChange={e=>setB({...b,currency:e.target.value.toUpperCase()})}/></label><label>Amount<input required inputMode="decimal" value={b.amount} onChange={e=>setB({...b,amount:e.target.value})}/></label>
      <label>Release id (optional)<input value={b.releaseId} onChange={e=>setB({...b,releaseId:e.target.value})}/></label><button className="refresh" disabled={ba.busy}>Save budget</button></form><Msg msg={ba.msg}/></Panel>}
    {labelId&&canWrite(session)&&list.length>0&&<Panel overline="SPEND" title="Record an expense"><form className="form-grid" onSubmit={e=>{e.preventDefault();const bud=list.find(y=>y.id===x.budgetId);const minor=bud&&toMinor(x.amount,bud.currency);if(!minor){xa.setMsg({ok:false,text:"Choose a budget and enter a valid amount."});return;}
      xa.run(()=>api("/api/v1/expenses",{method:"POST",body:{labelId,budgetId:x.budgetId,occurredOn:x.occurredOn,currency:bud.currency,amountMinor:minor,description:x.description.trim(),vendor:x.vendor.trim()||undefined}}),"Expense recorded.").then(r=>r&&reload())}}>
      <label>Budget<select required value={x.budgetId} onChange={e=>setX({...x,budgetId:e.target.value})}><option value="">Choose…</option>{list.filter(y=>y.labelId===labelId).map(y=><option key={y.id} value={y.id}>{y.name} ({y.period})</option>)}</select></label>
      <label>Date<input required type="date" value={x.occurredOn} onChange={e=>setX({...x,occurredOn:e.target.value})}/></label><label>Amount<input required inputMode="decimal" value={x.amount} onChange={e=>setX({...x,amount:e.target.value})}/></label>
      <label>Description<input required value={x.description} onChange={e=>setX({...x,description:e.target.value})}/></label><label>Vendor<input value={x.vendor} onChange={e=>setX({...x,vendor:e.target.value})}/></label>
      <button className="refresh" disabled={xa.busy}>Record expense</button></form><Msg msg={xa.msg}/></Panel>}
    {!labelId&&<p className="muted">Select a single label to create budgets or record expenses.</p>}
    <Panel overline="LEDGER" title="Recent expenses" right={<Badge status={expenses.status} empty={!expenses.data?.expenses?.length} synthetic={syn}/>}>
      {expenses.data?.expenses?.length?<ul className="plain-list">{expenses.data.expenses.map(e=><li key={e.id}>{e.occurredOn} · <b>{money(e.amountMinor,e.currency)}</b> · {e.description}{e.vendor?" ("+e.vendor+")":""} · {e.budgetId}</li>)}</ul>:<p className="muted">No expenses recorded.</p>}
    </Panel>
  </>;
}

/* Alerts --------------------------------------------------------------------------------------------- */
export function AlertsScreen({scope,menu,session}){
  const[status,setStatus]=useState("open");const syn=syntheticState(scope,menu);
  const feed=useLoad("/api/v1/alerts/feed"+q(scope,{status}),{interval:60000});const delivery=useLoad("/api/v1/alerts/delivery");const a=useAction();
  const alerts=feed.data?.alerts||[];
  return <>
    <Panel overline="ALERT FEED" title={status==="open"?alerts.length+" open alert(s)":"Alerts"} right={<Badge status={feed.status} empty={false} synthetic={syn}/>}>
      <div className="form-row"><label>Show <select value={status} onChange={e=>setStatus(e.target.value)}><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="resolved">Resolved</option><option value="all">All</option></select></label>
        {canManage(session)&&<button className="refresh" disabled={a.busy} onClick={()=>a.run(()=>api("/api/v1/alerts/evaluate",{method:"POST",body:{}}),r=>"Evaluated: "+r.open+" active, "+r.opened+" new, "+r.resolved+" resolved.").then(()=>feed.reload())}>Evaluate now</button>}</div>
      <Msg msg={a.msg}/>
      {alerts.length?<ul className="alert-list">{alerts.map(x=><li key={x.fingerprint} className={"alert-item "+x.severity}><b>{x.severity==="critical"?"Critical":"Warning"}</b><span>{x.message}</span>
        <small>{x.labelId} · {x.source} · since {x.firstSeenAt.slice(0,16).replace("T"," ")}{x.resolvedAt?" · resolved "+x.resolvedAt.slice(0,10):""}{x.acknowledgedAt?" · acknowledged by "+x.acknowledgedBy:""}{x.deliveredAt?" · delivered":x.deliveryError?" · delivery failed ("+x.deliveryError+")":""}</small>
        {!x.acknowledgedAt&&!x.resolvedAt&&canWrite(session)&&<button className="link-btn" onClick={()=>a.run(()=>api("/api/v1/alerts/feed/"+x.fingerprint+"/ack",{method:"POST",body:{}}),"Acknowledged.").then(()=>feed.reload())}>Acknowledge</button>}</li>)}</ul>
        :<p className="muted">{feed.status==="live"?"Nothing to show. The engine evaluates stale sources, dead-lettered jobs, volume drops/spikes and budget overruns every few minutes.":"Loading…"}</p>}
      {feed.data?.lastEvaluation&&<p className="muted">Last evaluation {feed.data.lastEvaluation.evaluatedAt.slice(0,16).replace("T"," ")} UTC.</p>}
    </Panel>
    <Panel overline="DELIVERY" title="Notification channels" right={<Badge status={delivery.status} empty={false}/>}>
      {delivery.data&&<ul className="plain-list"><li><b>In-app feed</b> — on</li>
        <li><b>Webhook</b> — {delivery.data.webhook.enabled?"on"+(delivery.data.webhook.signed?" (signed)":""):"off. "+delivery.data.webhook.enableWith}</li>
        <li><b>Email</b> — {delivery.data.email.enabled?"on ("+delivery.data.email.recipients+" recipient(s))":"off. "+delivery.data.email.enableWith}</li></ul>}
      <p className="muted">Alerts for the synthetic demo label stay in the feed and are never sent.</p>
    </Panel>
  </>;
}

/* Imports ---------------------------------------------------------------------------------------- */
export function ImportsScreen({scope,menu,session}){
  const providers=useLoad("/api/v1/providers");const history=useLoad("/api/v1/imports"+q(scope));
  const writable=(menu?.labels||[]).filter(l=>session?.labels==="all"||!Array.isArray(session?.labels)||session.labels.includes(l.id));
  const[f,setF]=useState({provider:"spotify",labelId:labelOf(scope)||"",statementId:"",mapping:""});const[file,setFile]=useState(null);const a=useAction();const[result,setResult]=useState(null);
  useEffect(()=>{if(labelOf(scope))setF(x=>({...x,labelId:labelOf(scope)}))},[scope]);
  const submit=async e=>{e.preventDefault();setResult(null);if(!file){a.setMsg({ok:false,text:"Choose a CSV file."});return;}
    if(file.size>5_000_000){a.setMsg({ok:false,text:"Files must be under 5 MB; split larger exports."});return;}
    let mapping;if(f.mapping.trim()){try{mapping=JSON.parse(f.mapping)}catch{a.setMsg({ok:false,text:"Column mapping must be JSON, e.g. {\"date\":\"Day\"}."});return;}}
    const csv=await file.text();
    const r=await a.run(()=>api("/api/v1/imports",{method:"POST",body:{provider:f.provider,labelId:f.labelId,csv,fileName:file.name,mapping,statementId:f.provider==="toolost"&&f.statementId.trim()?f.statementId.trim():undefined}}).catch(err=>{if(err.data?.import)return err.data;throw err}),
      r=>r.import.status==="duplicate"?"This statement was already imported.":r.import.accepted+" row(s) imported, "+r.import.rejected+" rejected.");
    if(r){setResult(r.import);history.reload();}};
  const p=(providers.data?.providers||[]).find(x=>x.id===f.provider);
  return <>
    <Panel overline="IMPORT" title="Upload an exported report">
      {canWrite(session)?<form className="form-grid" onSubmit={submit}>
        <label>Provider<select value={f.provider} onChange={e=>setF({...f,provider:e.target.value})}>{(providers.data?.providers||[{id:"spotify",name:"Spotify for Artists"}]).map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
        <label>Label<select required value={f.labelId} onChange={e=>setF({...f,labelId:e.target.value})}><option value="">Choose…</option>{writable.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        <label>CSV file<input type="file" accept=".csv,text/csv" onChange={e=>setFile(e.target.files[0]||null)}/></label>
        {f.provider==="toolost"&&<label>Statement id (optional)<input value={f.statementId} onChange={e=>setF({...f,statementId:e.target.value})} placeholder="derived from file"/></label>}
        <label className="wide">Column mapping override (optional JSON)<input value={f.mapping} onChange={e=>setF({...f,mapping:e.target.value})} placeholder='{"date":"Day","quantity":"Streams"}'/></label>
        <button className="refresh" disabled={a.busy}>{a.busy?"Importing…":"Import"}</button></form>:<WriteHint session={session}/>}
      <Msg msg={a.msg}/>
      {p&&<p className="muted">{p.name}: recognised columns — {Object.entries(p.columns).map(([k,v])=>k+" ("+v.slice(0,3).join(" / ")+")").join("; ")||"engine fact columns"}. Live API: {p.liveApi.enabled?"on":p.liveApi.available?"available but off — requires "+p.liveApi.requires.join(", "):"not available"}. {p.liveApi.reason}</p>}
      {result?.errors?.length>0&&<details open><summary>{result.errors.length} row error(s)</summary><ul className="plain-list">{result.errors.slice(0,50).map((x,i)=><li key={i}>{x.row?"Row "+x.row+": ":""}{x.error}</li>)}</ul></details>}
    </Panel>
    <Panel overline="HISTORY" title="Recent imports" right={<Badge status={history.status} empty={!history.data?.imports?.length}/>}>
      {history.data?.imports?.length?<div className="table-wrap"><table><thead><tr><th>WHEN</th><th>PROVIDER</th><th>FILE</th><th>ROWS</th><th>ACCEPTED</th><th>REJECTED</th><th>STATUS</th><th>BY</th></tr></thead><tbody>
        {history.data.imports.map(x=><tr key={x.id}><td>{x.importedAt.slice(0,16).replace("T"," ")}</td><td>{x.provider}</td><td>{x.fileName||"—"}</td><td>{formatInteger(x.rowCount)}</td><td>{formatInteger(x.accepted)}</td><td>{formatInteger(x.rejected)}</td><td>{x.status}</td><td>{String(x.importedBy).split("/").pop()}</td></tr>)}</tbody></table></div>:<p className="muted">No imports yet.</p>}
    </Panel>
    <Panel overline="CONNECTORS" title="Provider connections">
      <div className="table-wrap"><table><thead><tr><th>PROVIDER</th><th>CSV UPLOAD</th><th>LIVE API</th></tr></thead><tbody>{(providers.data?.providers||[]).map(x=><tr key={x.id}><td><b>{x.name}</b></td><td>Available</td><td>{x.liveApi.enabled?"On":x.liveApi.available?"Off — needs credentials":"No public API"}</td></tr>)}</tbody></table></div>
    </Panel>
  </>;
}

/* Admin ------------------------------------------------------------------------------------------- */
const ROLE_TEXT={tenant_admin:"Administrator (all labels)",label_manager:"Label manager (edit)",team_member:"Team member (read)",artist:"Artist (read)"};
export function AdminScreen({menu,session,onMenuChange}){
  const users=useLoad("/api/admin/users");const a=useAction();const da=useAction();
  const rollups=useLoad("/api/v1/rollups/status");
  const labels=menu?.labels||[];
  const[f,setF]=useState({email:"",displayName:"",role:"team_member",labelIds:[],password:""});
  const create=e=>{e.preventDefault();a.run(()=>api("/api/admin/users",{method:"POST",body:{email:f.email.trim(),displayName:f.displayName.trim()||undefined,role:f.role,labelIds:f.role==="tenant_admin"?["*"]:f.labelIds,password:f.password}}),"User created. Share the password with them securely.").then(r=>{if(r){setF({email:"",displayName:"",role:"team_member",labelIds:[],password:""});users.reload()}})};
  if(!session?.permissions?.manage)return <div className="panel empty"><h3>Administrators only</h3><p>Your role does not include user administration.</p></div>;
  if(session?.features?.write===false)return <div className="panel empty"><h3>User management is not configured</h3><p>Set ENGINE_WRITE_API_KEY on the Command Center and ENGINE_CONSOLE_KEY (same value) on the engine.</p></div>;
  return <>
    <Panel overline="USERS" title="People who can sign in" right={<Badge status={users.status} empty={false}/>}>
      {users.data?.localAdmin&&<p className="muted">Built-in administrator <b>{users.data.localAdmin.username}</b> (from ADMIN_PASSWORD) · all labels.{users.data.oidc?" Organization sign-in (OIDC) is also enabled.":""}</p>}
      <div className="table-wrap"><table><thead><tr><th>USER</th><th>ROLE</th><th>LABELS</th><th>STATUS</th><th></th></tr></thead><tbody>
        {(users.data?.accounts||[]).map(u=><UserRow key={u.id} user={u} labels={labels} onSaved={users.reload}/>)}
        {users.data&&!users.data.accounts.length&&<tr><td colSpan="5">No additional users yet.</td></tr>}</tbody></table></div>
    </Panel>
    <Panel overline="INVITE" title="Add a user"><form className="form-grid" onSubmit={create}>
      <label>Email (sign-in name)<input required type="email" value={f.email} onChange={e=>setF({...f,email:e.target.value})}/></label>
      <label>Display name<input value={f.displayName} onChange={e=>setF({...f,displayName:e.target.value})}/></label>
      <label>Role<select value={f.role} onChange={e=>setF({...f,role:e.target.value})}>{Object.entries(ROLE_TEXT).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      <label>Initial password (14+ characters)<input required type="password" minLength="14" autoComplete="new-password" value={f.password} onChange={e=>setF({...f,password:e.target.value})}/></label>
      {f.role!=="tenant_admin"&&<fieldset className="wide"><legend>Labels</legend>{labels.map(l=><label key={l.id} className="check"><input type="checkbox" checked={f.labelIds.includes(l.id)} onChange={e=>setF({...f,labelIds:e.target.checked?[...f.labelIds,l.id]:f.labelIds.filter(x=>x!==l.id)})}/>{l.name}</label>)}</fieldset>}
      <button className="refresh" disabled={a.busy}>Create user</button></form><Msg msg={a.msg}/></Panel>
    <Panel overline="DEMO" title="Synthetic demo data">
      <p className="muted">Creates the label “Synthetic Demo Label (not real data)” with 60 days of synthetic streams, sales, events, statements, split rules and budgets so every screen can be explored. Everything it creates is flagged synthetic and shown as such. Removing it deletes only that label.</p>
      <div className="form-row"><button className="refresh" disabled={da.busy} onClick={()=>da.run(()=>api("/api/admin/demo-data",{method:"POST",body:{}}),r=>"Seeded "+r.facts+" synthetic facts.").then(r=>r&&onMenuChange())}>Load demo data</button>
        <button className="refresh" disabled={da.busy} onClick={()=>{if(confirm("Remove all synthetic demo data?"))da.run(()=>api("/api/admin/demo-data/remove",{method:"POST",body:{}}),r=>r.deleted?"Demo data removed.":"No demo data was present.").then(r=>r&&onMenuChange())}}>Remove demo data</button></div>
      <Msg msg={da.msg}/></Panel>
    <Panel overline="ENGINE" title="Stored rollups" right={<Badge status={rollups.status} empty={false}/>}>
      <ul className="plain-list">{(rollups.data?.labels||[]).map(l=><li key={l.labelId}><b>{labels.find(x=>x.id===l.labelId)?.name||l.labelId}</b> — {l.fresh?"current":"refresh pending"} · {formatInteger(l.facts)} facts{l.refreshedAt?" · refreshed "+l.refreshedAt.slice(0,16).replace("T"," "):""}</li>)}</ul>
    </Panel>
  </>;
}
function UserRow({user,labels,onSaved}){
  const[edit,setEdit]=useState(false),[role,setRole]=useState(user.role),[ids,setIds]=useState(user.labelIds.filter(x=>x!=="*")),[pw,setPw]=useState("");const a=useAction();
  const save=body=>a.run(()=>api("/api/admin/users/"+user.id,{method:"POST",body}),"Saved.").then(r=>{if(r){setEdit(false);setPw("");onSaved()}});
  return <tr><td><b>{user.displayName||user.email}</b><small className="release-label">{user.email}</small></td>
    <td>{edit?<select value={role} onChange={e=>setRole(e.target.value)}>{Object.entries(ROLE_TEXT).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select>:ROLE_TEXT[user.role]}</td>
    <td>{edit&&role!=="tenant_admin"?labels.map(l=><label key={l.id} className="check"><input type="checkbox" checked={ids.includes(l.id)} onChange={e=>setIds(e.target.checked?[...ids,l.id]:ids.filter(x=>x!==l.id))}/>{l.name}</label>):user.labelIds.includes("*")?"All":user.labelIds.map(id=>labels.find(l=>l.id===id)?.name||id).join(", ")}</td>
    <td>{user.disabled?"Disabled":"Active"}</td>
    <td>{edit?<><input type="password" placeholder="New password (optional)" minLength="14" value={pw} onChange={e=>setPw(e.target.value)} autoComplete="new-password"/>
      <button className="link-btn" disabled={a.busy} onClick={()=>save({role,labelIds:role==="tenant_admin"?["*"]:ids,...(pw?{password:pw}:{})})}>Save</button><button className="link-btn" onClick={()=>setEdit(false)}>Cancel</button></>
      :<><button className="link-btn" onClick={()=>setEdit(true)}>Edit</button><button className="link-btn" disabled={a.busy} onClick={()=>save({disabled:!user.disabled})}>{user.disabled?"Enable":"Disable"}</button></>}<Msg msg={a.msg}/></td></tr>;
}
