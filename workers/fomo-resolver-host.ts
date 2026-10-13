import {superviseResolver} from '../server/resolver-supervisor.js';
import {spawn,type ChildProcess} from 'node:child_process';
import {writeFile,unlink,access,mkdir} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {resolverHealth,resolverHealthServer} from '../server/fomo-resolver-health.js';
const setup=process.env.FOMO_RESOLVER_SETUP==='true';
const children:ChildProcess[]=[];let stopping=false;const stopSignal=new AbortController();
const stop=()=>{stopping=true;stopSignal.abort();for(const child of children)child.kill('SIGTERM');};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
function launch(command:string,args:string[],quiet=false){
 const child=spawn(command,args,{env:{...process.env,DISPLAY:':99'},stdio:quiet?'ignore':'inherit'});children.push(child);child.once('exit',()=>{const i=children.indexOf(child);if(i>=0)children.splice(i,1);});
 child.on('error',()=>{console.error('Resolver host dependency unavailable.');process.exitCode=1;stop();});return child;
}
const passwordFile='/tmp/fub-resolver-console-password';
let expiry:ReturnType<typeof setTimeout>|undefined;
let pulse:ReturnType<typeof setInterval>|undefined;
let healthServer:ReturnType<typeof resolverHealthServer>|undefined;
try{
 // Fomo account hydration requires the same displayed Chrome mode used at login.
  const display=launch('Xvfb',[':99','-screen','0','1280x900x24','-nolisten','tcp','-ac'],true);
  for(let n=0;n<50;n++){if(display.exitCode!==null||stopping)throw Error('Display unavailable.');try{await access('/tmp/.X11-unix/X99');break;}catch{if(n===49)throw Error('Display unavailable.');await delay(100);}}
 display.on('exit',()=>{if(!stopping){process.exitCode=1;stop();}});
 if(setup){
  const until=Number(process.env.FOMO_RESOLVER_SETUP_EXPIRES_AT),remaining=until-Date.now();
  const password=process.env.FOMO_RESOLVER_CONSOLE_PASSWORD||'';
  if(!Number.isSafeInteger(until)||remaining<=0||remaining>3600000||!/^[A-Za-z0-9_-]{8}$/.test(password))throw Error('Invalid or expired private login window.');
  await writeFile(passwordFile,password+'\n',{mode:0o600});
  expiry=setTimeout(()=>{console.log('Private login window expired.');stop();},remaining);
  const vnc=launch('x11vnc',['-display',':99','-localhost','-rfbport','5900','-passwdfile',passwordFile,'-forever','-shared','-noxdamage','-nosel'],true);
  const proxy=launch('websockify',['--web=/usr/share/novnc','[::]:6080','127.0.0.1:5900'],true);
  for(const [label,child] of [['vnc',vnc],['proxy',proxy]] as const)child.on('exit',(code)=>{if(!stopping){console.error(JSON.stringify({event:'resolver_console_stopped',component:label,code}));process.exitCode=1;stop();}});
 }
 if(stopping)throw Error('Host stopped.');
 // No automation/debugging connection during OAuth. The operator controls
 // ordinary Chrome directly; no browser session is copied from their Mac.
 let worker:ChildProcess;
 if(setup){
  const directory=process.env.FOMO_RESOLVER_BROWSER_DIR;
  if(directory!=='/data/.fomo-resolver-browser')throw Error('Unexpected browser directory.');
  await mkdir(directory,{recursive:true,mode:0o700});
  const health=resolverHealth();health.update('paused');
  healthServer=resolverHealthServer(health,Number(process.env.FOMO_RESOLVER_HEALTH_PORT||8080));
  pulse=setInterval(()=>health.update('paused'),10000);
  worker=launch('/usr/bin/google-chrome-stable',['--user-data-dir='+directory,'--no-first-run','--no-default-browser-check','--window-size=1280,850','https://fomo.family/'],true);
  console.log(JSON.stringify({event:'resolver_manual_login',automationAttached:false}));
  await new Promise<void>(resolve=>worker.on('exit',(code,signal)=>{if(!stopping)process.exitCode=code??(signal?1:0);resolve();}));
 }else await superviseResolver(()=>new Promise<void>(resolve=>{
  const child=launch(process.execPath,['.worker-dist/workers/fomo-resolver.js']);
  child.once('exit',()=>resolve());child.once('error',()=>resolve());
 }),stopSignal.signal,{now:Date.now,wait:async(ms,signal)=>{await delay(ms,undefined,{signal});},report:delayMs=>console.log(JSON.stringify({event:'resolver_restart_scheduled',delayMs}))});
}catch{if(!stopping){console.error('Resolver host stopped; inspect private setup configuration.');process.exitCode=1;}}
finally{stop();clearTimeout(expiry);clearInterval(pulse);healthServer?.close();await unlink(passwordFile).catch(()=>{});}
