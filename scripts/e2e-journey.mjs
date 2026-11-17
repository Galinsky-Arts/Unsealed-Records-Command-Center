// End-to-end journey against a running Command Center + engine: admin login, synthetic demo data,
// a temporary label-manager test user, CSV import as that user, report checks, access boundaries,
// then the test user is disabled and the demo data removed.
// Env: E2E_BASE_URL, E2E_ADMIN_USERNAME (default admin), E2E_ADMIN_PASSWORD. Prints no secrets.
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';

const base=(process.env.E2E_BASE_URL||'').replace(/\/$/,'');
const origin=process.env.E2E_ORIGIN||base;
if(!base||!process.env.E2E_ADMIN_PASSWORD){console.error('Set E2E_BASE_URL and E2E_ADMIN_PASSWORD');process.exit(1);}
const log=(step,detail='')=>console.log('✔ '+step+(detail?' — '+detail:''));
function client(){
 let cookie='';
 const call=async(path,{method='GET',body}={})=>{
  const r=await fetch(base+path,{method,redirect:'manual',signal:AbortSignal.timeout(240000),
   headers:{origin,...(cookie?{cookie}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined});
  const set=r.headers.get('set-cookie');if(set) cookie=set.split(';')[0];
  const data=await r.json().catch(()=>null);return {status:r.status,data};
 };
 return {call,login:(username,password)=>call('/auth/login',{method:'POST',body:{username,password}})};
}

const admin=client(),user=client();
const email='e2e-'+randomBytes(4).toString('hex')+'@example.test',password=randomBytes(18).toString('base64url');
let userId=null,seeded=false,failed=false;
try{
 assert.equal((await fetch(base+'/healthz')).status,200);log('health');
 assert.equal((await admin.call('/api/v1/scopes')).status,401);log('anonymous API access refused');
 assert.equal((await admin.login(process.env.E2E_ADMIN_USERNAME||'admin',process.env.E2E_ADMIN_PASSWORD)).status,200);log('admin login');
 const s=await admin.call('/api/session');assert.equal(s.data.role,'tenant_admin');assert.equal(s.data.features.write,true,'console write key configured');
 let r=await admin.call('/api/admin/demo-data',{method:'POST',body:{}});assert.equal(r.status,200,JSON.stringify(r.data));seeded=true;log('synthetic demo data loaded',r.data.facts+' facts');
 r=await admin.call('/api/v1/scopes');assert.ok(r.data.labels.some(l=>l.id==='synthetic-demo'&&l.synthetic));
 const otherLabel=r.data.labels.find(l=>l.id!=='synthetic-demo')?.id;
 r=await admin.call('/api/admin/users',{method:'POST',body:{email,displayName:'E2E test user (temporary)',role:'label_manager',labelIds:['synthetic-demo'],password}});
 assert.equal(r.status,201,JSON.stringify(r.data));userId=r.data.account.id;log('temporary test user created','label_manager on synthetic-demo');
 assert.equal((await user.login(email,'wrong-password-value')).status,401);
 assert.equal((await user.login(email,password)).status,200);
 r=await user.call('/api/session');assert.equal(r.data.role,'label_manager');assert.deepEqual(r.data.labels,['synthetic-demo']);log('test user login','role and label scope from the engine');
 const window='labelId=synthetic-demo&from=2020-01-15&to=2020-01-16';
 r=await user.call('/api/v1/summary?'+window);assert.equal(r.status,200);const before=BigInt(r.data.counts.streams);
 const csv='Date,Song,ISRC,Streams,Country\n2020-01-15,Neon Harbor,ZZDEM2600001,"4,242",US\n2020-01-15,Glass Tides,ZZ-DEM-26-00002,58,GB\n2020-01-15,Broken row,ZZDEM2600003,abc,US\n';
 r=await user.call('/api/v1/imports',{method:'POST',body:{provider:'spotify',labelId:'synthetic-demo',fileName:'e2e-spotify.csv',csv}});
 assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.import.accepted,2);assert.equal(r.data.import.rejected,1);assert.equal(r.data.import.errors[0].row,4);
 log('CSV import as test user','2 accepted, 1 rejected with row number');
 r=await user.call('/api/v1/summary?'+window);assert.equal(BigInt(r.data.counts.streams)-before,4300n);assert.equal(r.data.synthetic,true);log('summary report','+4300 streams, flagged synthetic');
 r=await user.call('/api/v1/rollups/daily?'+window);assert.equal(r.status,200);
 assert.equal(r.data.rollups.filter(x=>x.type==='stream'&&x.source==='spotify').reduce((a,x)=>a+BigInt(x.quantity),0n),4300n);log('daily rollup report','materialized='+r.data.materialized);
 r=await user.call('/api/v1/catalog/isrc/ZZDEM2600002?labelId=synthetic-demo');assert.equal(r.data.facts[0].unmapped,0);log('ISRC mapping','imported rows attributed to catalog tracks');
 r=await user.call('/api/v1/imports?labelId=synthetic-demo');assert.ok(r.data.imports.some(i=>i.fileName==='e2e-spotify.csv'&&i.importedBy.endsWith(email)));log('import history','attributed to the test user');
 r=await user.call('/api/v1/royalties/preview?labelId=synthetic-demo&period='+new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth()-1,1)).toISOString().slice(0,7));
 assert.equal(r.status,200);assert.ok(r.data.statements.length>0);log('royalty preview',r.data.statements.length+' payee statements');
 assert.equal((await user.call('/api/v1/summary')).status,403);
 if(otherLabel) assert.equal((await user.call('/api/v1/summary?labelId='+encodeURIComponent(otherLabel))).status,403);
 assert.equal((await user.call('/api/admin/users')).status,403);
 assert.equal((await user.call('/api/v1/royalties/payouts',{method:'POST',body:{labelId:'synthetic-demo'}})).status,403);
 log('access boundaries','other labels, all-label scope, admin and payouts refused');
}catch(e){failed=true;console.error('✘ '+(e.message||e));}
finally{
 if(userId){const r=await admin.call('/api/admin/users/'+userId,{method:'POST',body:{disabled:true}});
  const again=await client().login(email,password);
  if(r.status===200&&again.status===401) log('test user disabled','login now refused');else{failed=true;console.error('✘ could not disable test user');}}
 if(seeded){const r=await admin.call('/api/admin/demo-data/remove',{method:'POST',body:{}});if(r.status===200) log('synthetic demo data removed');else{failed=true;console.error('✘ demo data removal failed');}}
 await admin.call('/auth/logout',{method:'POST'});
}
console.log(failed?'E2E FAILED':'E2E PASSED');process.exitCode=failed?1:0;
