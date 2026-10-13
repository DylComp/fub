import {mkdir,lstat,open,rename,readdir,readFile,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {archivePublicKey,sealLedgerArchive,type LedgerKind} from './ledger-archive.js';
import {snapshotPrivateLedger} from './private-ledger-restore.js';
import {snapshotApplicationLedger} from './application-ledger-store.js';
const hourly=3600000,staleAfter=75*60000,retained=24;
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export async function saveHostedArchive(directory:string,kind:LedgerKind,bytes:Buffer,now=Date.now()){
 const metadata=await lstat(directory);
 if(!metadata.isDirectory()||metadata.isSymbolicLink()||(metadata.mode&0o077)||!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>34*1024*1024)throw Error('Archive directory or size refused.');
 const name=`${now}-${randomUUID()}-${kind}.aesgcm`,path=join(directory,name),temporary=path+'.partial';
 const handle=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{
  try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  if(digest(await readFile(temporary))!==digest(bytes))throw Error('Saved archive differs.');
  await rename(temporary,path);
 }catch(error){await unlink(temporary).catch(()=>{});throw error;}
 const dir=await open(directory,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}
 // Only rotate this ledger's completed archives after a durable new write.
 const pattern=new RegExp('^[0-9]{13}-[a-f0-9-]{36}-'+kind+'\\.aesgcm$');
 const files=(await readdir(directory)).filter(f=>pattern.test(f)).sort().reverse();
 for(const expired of files.slice(retained)){const file=join(directory,expired),stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Archive rotation refused.');await unlink(file);}
 return{name,bytes:bytes.length,retained:Math.min(files.length,retained)};
}
export function hostedBackupLoop(work:()=>Promise<{bytes:number;retained:number}>,now:()=>number=Date.now){
 let running=false,lastSuccess:number|null=null,lastAttempt:number|null=null,failed=false,bytes=0,count=0;
 return{
  async tick(){
   const at=now();if(running||lastSuccess!==null&&at>=lastSuccess&&at-lastSuccess<hourly||failed&&lastAttempt!==null&&at>=lastAttempt&&at-lastAttempt<(lastSuccess===null?60000:300000))return;
   running=true;lastAttempt=at;
   try{const result=await work();bytes=result.bytes;count=result.retained;lastSuccess=now();failed=false;}
   catch{failed=true;}
   finally{running=false;}
  },
  snapshot(){const at=now();return{status:lastSuccess!==null&&(at<lastSuccess||at-lastSuccess>staleAfter)?'stale':failed?'degraded':lastSuccess===null?'starting':'healthy',running,lastSuccess,lastAttempt,bytes,retained:count,intervalMs:hourly};},
 };
}
export function startHostedLedgerBackup(env:Record<string,string|undefined>,kind:LedgerKind){
 if(env.LEDGER_BACKUP_ENABLED!==undefined&&!['true','false'].includes(env.LEDGER_BACKUP_ENABLED))throw Error('Invalid backup setting.');
 if(env.LEDGER_BACKUP_ENABLED!=='true')return undefined;
 const publicKey=env.LEDGER_BACKUP_PUBLIC_KEY||'';archivePublicKey(publicKey);
 const url=kind==='private'?env.SIGNER_DATABASE_URL:env.DATABASE_URL;if(!url)throw Error('Backup database unavailable.');
 const directory='/data/backups',migrationDirectory=kind==='private'?'signer-migrations':'migrations';
 const loop=hostedBackupLoop(async()=>{
  await mkdir(directory,{recursive:true,mode:0o700});
  const names=(await readdir(migrationDirectory)).filter(n=>/^\d{3}_[a-z0-9_]+\.sql$/.test(n)).sort();
  const migrations=await Promise.all(names.map(async name=>({name,sha256:digest(await readFile(join(migrationDirectory,name),'utf8'))})));
  const value=kind==='private'?await snapshotPrivateLedger(url,migrations):await snapshotApplicationLedger(url,migrations);
  return saveHostedArchive(directory,kind,sealLedgerArchive(kind,value,publicKey));
 });
 let lastStatus='';
 const tick=async()=>{await loop.tick();const state=loop.snapshot();if(state.status!==lastStatus){lastStatus=state.status;console.log(JSON.stringify({event:'ledger_backup',kind,...state}));}};
 const timer=setInterval(()=>{void tick();},60000);timer.unref();void tick();
 return{snapshot:loop.snapshot,stop:()=>clearInterval(timer)};
}
