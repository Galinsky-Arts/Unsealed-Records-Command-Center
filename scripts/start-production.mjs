import {loadAppConfig,createAppServer} from '../src/server/app.mjs';
let config;
try{
 config=loadAppConfig(process.env);
}catch(error){
 // Report only the configuration name in the fixed message, never values or environment contents.
 const name=/^Invalid configuration: ([A-Za-z0-9_ -]+)$/.exec(error?.message||'')?.[1];
 process.stderr.write('Production startup refused; verify server configuration and application artifact.'+(name?' ('+name+')':'')+'\n');
 process.exit(1);
}
const server=createAppServer(config);
server.listen(config.port,'0.0.0.0',()=>process.stdout.write('Command Center listening on '+config.port+(config.oidc?' (OIDC enabled)':'')+(config.adminPassword?' (local admin login enabled)':'')+'\n'));
// Startup connectivity evidence: status codes only, never bodies, URLs with credentials or keys.
(async()=>{
 const probe=async(path,token)=>{try{const r=await fetch(new URL(path,config.engineOrigin),{redirect:'error',signal:AbortSignal.timeout(60000),
  headers:token?{authorization:'Bearer '+token,accept:'application/json'}:{accept:'application/json'}});await r.body?.cancel();return r.status;}catch{return 'unreachable';}};
 const health=await probe('/health'),read=await probe('/v1/scopes',config.engineToken);
 const write=config.engineWriteToken?await probe('/v1/auth/me',config.engineWriteToken):'not-configured';
 process.stdout.write('Engine probe: health='+health+' authorized-read='+read+' console-write='+write+'\n');
})();
const stop=()=>server.close(()=>process.exit(0));
process.once('SIGTERM',stop);process.once('SIGINT',stop);
