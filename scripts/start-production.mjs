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
const stop=()=>server.close(()=>process.exit(0));
process.once('SIGTERM',stop);process.once('SIGINT',stop);
