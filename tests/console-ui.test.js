import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {JSDOM} from 'jsdom';

async function until(check,what='expected state') {
  for(let i=0;i<300;i++){if(check())return;await pause(10);}
  throw new Error('Dashboard did not reach '+what);
}
async function boot(t,handler,session){
  const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/',runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
  const window=dom.window,calls=[];
  const ok=(data,status=200)=>({ok:status<400,status,json:async()=>data});
  window.fetch=async(path,init={})=>{
    calls.push({path,method:init.method||'GET',body:init.body?JSON.parse(init.body):undefined});
    if(path==='/api/session')return ok(session);
    if(path.startsWith('/api/v1/scopes'))return ok({all:{name:'All'},labels:[{id:'alpha-label',name:'Alpha',synthetic:false},{id:'synthetic-demo',name:'Synthetic Demo Label (not real data)',synthetic:true}],families:[]});
    if(path.startsWith('/api/v1/summary'))return ok({synthetic:false,counts:{sales:0,streams:0,plays:0,events:2,attendees:40},scope:{labelIds:['alpha-label']},byRelease:{},bySource:{},daily:[]});
    const r=handler(path,init,ok);return r||ok({});
  };
  window.confirm=()=>true;
  const files=await readdir('dist/assets');window.eval(await readFile('dist/assets/'+files.find(f=>f.endsWith('.js')),'utf8'));
  const document=window.document;
  await until(()=>document.querySelector('#label-scope')?.options.length===3,'label menu');
  const nav=name=>{const b=[...document.querySelectorAll('.sidebar nav button')].find(b=>b.textContent===name);assert.ok(b,'tab '+name);b.click();};
  const choose=value=>{const s=document.querySelector('#label-scope');s.value=value;s.dispatchEvent(new window.Event('change',{bubbles:true}));};
  return {window,document,calls,nav,choose};
}
const admin={authenticated:true,subject:'local:admin',method:'local',role:'tenant_admin',labels:'all',permissions:{read:true,write:true,manage:true},features:{write:true,qr:true}};

test('Royalties screen previews statements, saves split rules and labels synthetic data',async t=>{
  const {document,calls,nav,choose,window}=await boot(t,(path,init,ok)=>{
    if(path.startsWith('/api/v1/royalties/preview'))return ok({statements:[{payeeId:'artist:a',payeeName:'Artist A',currency:'USD',recognizedMinor:'1234',pendingMinor:'50',lines:[]}],
      revenue:[{currency:'USD',recognizedMinor:'2468',pendingMinor:'100'}],rules:[],defaultRule:'system-default',policy:'Recognized = settled.'});
    if(path.startsWith('/api/v1/royalties/rules')&&init.method!=='POST')return ok({rules:[]});
    if(path.startsWith('/api/v1/royalties/statements')&&init.method==='POST')return ok({statements:[{}],conflicts:[]});
    if(path.startsWith('/api/v1/royalties'))return ok({statements:[],balances:[],payouts:[]});
  },admin);
  nav('Royalties');await until(()=>document.body.textContent.includes('Choose a single label'),'label prompt');
  choose('label:synthetic-demo');
  await until(()=>document.body.textContent.includes('Artist A'),'preview');
  assert.ok(document.body.textContent.includes('USD 12.34'));
  assert.ok(document.body.textContent.includes('Synthetic demo data'),'synthetic badge');
  [...document.querySelectorAll('button')].find(b=>b.textContent==='Save draft statements').click();
  await until(()=>calls.some(c=>c.method==='POST'&&c.path==='/api/v1/royalties/statements'),'draft post');
  assert.deepEqual(calls.find(c=>c.method==='POST'&&c.path==='/api/v1/royalties/statements').body,{labelId:'synthetic-demo',period:calls.find(c=>c.path.startsWith('/api/v1/royalties/preview')).path.split('period=')[1],finalize:false});
  [...document.querySelectorAll('button')].find(b=>b.textContent==='Save rule').click();
  await until(()=>calls.some(c=>c.method==='POST'&&c.path==='/api/v1/royalties/rules'),'rule post');
  assert.deepEqual(calls.find(c=>c.method==='POST'&&c.path==='/api/v1/royalties/rules').body.splits.map(s=>s.shareBps),[5000,5000]);
});

test('Admin, Imports and Alerts screens are wired; read-only roles see no admin tab',async t=>{
  const {document,calls,nav,choose}=await boot(t,(path,init,ok)=>{
    if(path==='/api/admin/users')return ok({accounts:[{id:'11111111-1111-4111-8111-111111111111',email:'mgr@example.test',role:'label_manager',labelIds:['alpha-label'],disabled:false}],localAdmin:{username:'admin'}});
    if(path.startsWith('/api/v1/providers'))return ok({providers:[{id:'spotify',name:'Spotify for Artists',columns:{date:['date']},liveApi:{available:false,enabled:false,reason:'No public API.',requires:[]}}]});
    if(path.startsWith('/api/v1/imports'))return ok({imports:[{id:'i1',importedAt:'2026-11-16T10:00:00.000Z',provider:'spotify',fileName:'s.csv',rowCount:3,accepted:3,rejected:0,status:'imported',importedBy:'command-center-console/local:admin'}]});
    if(path.startsWith('/api/v1/alerts/feed'))return ok({alerts:[{fingerprint:'f'.repeat(64),severity:'warning',type:'budget_overrun',labelId:'alpha-label',source:'budget',message:'Budget "Ads" is over',firstSeenAt:'2026-11-16T10:00:00.000Z'}]});
    if(path.startsWith('/api/v1/alerts/delivery'))return ok({feed:{enabled:true},webhook:{enabled:false,enableWith:'Set ALERT_WEBHOOK_URL.'},email:{enabled:false,enableWith:'Set RESEND_API_KEY.'}});
  },admin);
  nav('Admin');await until(()=>document.body.textContent.includes('mgr@example.test'),'users');
  assert.ok(document.body.textContent.includes('Label manager (edit)'));
  nav('Imports');await until(()=>document.body.textContent.includes('s.csv'),'history');
  assert.ok(document.body.textContent.includes('No public API'));
  nav('Alerts');await until(()=>document.body.textContent.includes('Budget "Ads" is over'),'alerts');
  assert.ok(document.body.textContent.includes('Set ALERT_WEBHOOK_URL.'));
  [...document.querySelectorAll('button')].find(b=>b.textContent==='Acknowledge').click();
  await until(()=>calls.some(c=>c.method==='POST'&&c.path==='/api/v1/alerts/feed/'+'f'.repeat(64)+'/ack'),'ack');
  const viewer=await boot(t,()=>null,{...admin,role:'team_member',permissions:{read:true,write:false,manage:false}});
  assert.ok(![...viewer.document.querySelectorAll('.sidebar nav button')].some(b=>b.textContent==='Admin'));
});
