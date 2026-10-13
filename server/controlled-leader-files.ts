import {open,readFile,lstat,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateLeaderTestState,type LeaderTestState,type LeaderTestStore,type ControlledTestPolicy} from './controlled-leader-test.js';

export async function privateTestDirectory(path:string){
 const stat=await lstat(path);
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw Error('Test directory must be private and must not be a symbolic link.');
}
export async function readPrivateTestFile(path:string){
 const stat=await lstat(path);
 if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.size>1000000)throw Error('Test file is not private or is too large.');
 return JSON.parse(await readFile(path,'utf8'));
}
export async function savePrivateTestFile(directory:string,name:string,value:unknown){
 await privateTestDirectory(directory);
 if(!/^[a-z-]+\.json$/.test(name))throw Error('Invalid journal name.');
 const temporary=join(directory,`.pending-${randomUUID()}`),file=await open(temporary,'wx',0o600);
 try{await file.writeFile(JSON.stringify(value,null,2)+'\n');await file.sync();}finally{await file.close();}
 await rename(temporary,join(directory,name));
 const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}
}
export function controlledLeaderFiles(directory:string,leader:string,policy?:ControlledTestPolicy):LeaderTestStore{
 return {async exclusive(work){
  await privateTestDirectory(directory);
  // Never steal a lock based on elapsed time. A crash requires operator review;
  // the persisted attempt still prevents automatic signing or sending again.
  const lockPath=join(directory,'run.lock'),lock=await open(lockPath,'wx',0o600);
  try{
   await lock.writeFile(JSON.stringify({pid:process.pid,createdAt:Date.now()}));await lock.sync();
   const state=await readPrivateTestFile(join(directory,'state.json')) as LeaderTestState;
   validateLeaderTestState(state,policy);if(state.leader!==leader)throw Error('Test wallet changed.');
   const carryover=JSON.stringify([state.carryover,state.closedCycle]);
    return await work(state,async next=>{validateLeaderTestState(next,policy);if(next.leader!==leader||JSON.stringify([next.carryover,next.closedCycle])!==carryover)throw Error('Test wallet or prior debit changed.');await savePrivateTestFile(directory,'state.json',next);});
  }finally{await lock.close();await unlink(lockPath);}
 }};
}
