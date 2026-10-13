import {Connection} from '@solana/web3.js';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {copyReadRpc} from './copy-rpc.js';
import {blockRecoveryRpc} from './copy-block-recovery.js';
import {launchExecutionStore} from './launch-execution-store.js';
import {launchExecutionChain} from './launch-execution-chain.js';
import {launchExecutionService} from './launch-execution-service.js';
import {launchTableStore} from './pump-pair-table-journal.js';
import {launchTableChain,launchTableService} from './pump-pair-table-recovery.js';

export type LaunchRecoveryHealth={phase:'starting'|'running'|'degraded'|'stopped';lastCompletedAt:number|null;checked:number;failed:number;iterations:number};
export const initialLaunchRecoveryHealth=():LaunchRecoveryHealth=>({phase:'starting',lastCompletedAt:null,checked:0,failed:0,iterations:0});
export function launchRecoveryStatus(state:LaunchRecoveryHealth,now=Date.now()){
 const ready=state.phase==='running'&&state.lastCompletedAt!==null&&now>=state.lastCompletedAt&&now-state.lastCompletedAt<120000;
 return {status:ready?'ready':state.phase==='running'?'stale':state.phase,mode:'recover',checked:state.checked,failed:state.failed,iterations:state.iterations};
}
// This transport cannot send, simulate, or request signatures, even if a caller
// accidentally invokes a write method on the web3 Connection.
export function launchRecoveryConnection(endpoint:string,signal:AbortSignal){
 return new Connection(endpoint,{commitment:'finalized',disableRetryOnRateLimit:true,fetch:async(_input,init)=>{
  signal.throwIfAborted();
  const request=JSON.parse(String(init?.body||'{}'));
  if(!['getGenesisHash','getTransaction','getBlockHeight','getMultipleAccounts','getAccountInfo'].includes(request.method))throw Error('Launch recovery permits only confirmation reads.');
  const result=await copyReadRpc(endpoint,signal)(request.method,request.params||[]);
  return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}),{headers:{'content-type':'application/json'}});
 }});
}
export function launchRecoveryTick(config:{url:string;endpoint:string;archiveEndpoint?:string}){
 return async(signal:AbortSignal)=>{
  signal.throwIfAborted();
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
  const chain=launchExecutionChain(launchRecoveryConnection(config.endpoint,deadline),()=>blockRecoveryRpc(config.archiveEndpoint||config.endpoint,deadline));
  // No sender is installed in this lane. Durable receipts alone can settle it.
  chain.send=async()=>{throw Error('Launch recovery cannot submit transactions.');};
  const tables=launchTableChain(launchRecoveryConnection(config.endpoint,deadline),()=>blockRecoveryRpc(config.archiveEndpoint||config.endpoint,deadline));
  tables.send=async()=>{throw Error('Launch recovery cannot submit transactions.');};
  const results=(await Promise.all([
   launchExecutionService(launchExecutionStore(config.url),chain,()=>false).sweep(deadline),
   launchTableService(launchTableStore(config.url),tables,()=>false).sweep(deadline),
  ])).flat();
  deadline.throwIfAborted();
  return {checked:results.filter(r=>r.checked).length,failed:results.filter(r=>!r.checked).length};
 };
}
function wait(signal:AbortSignal){
 return new Promise<void>(resolve=>{
  const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
  const timer=setTimeout(done,60000);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();
 });
}
export async function runLaunchRecovery(tick:(signal:AbortSignal)=>Promise<{checked:number;failed:number}>,state:LaunchRecoveryHealth,signal:AbortSignal,onChange:(state:LaunchRecoveryHealth)=>void=()=>{},once=false){
 let previous='';
 try{
  while(!signal.aborted){
   try{const result=await tick(signal);if(signal.aborted)break;state.checked=result.checked;state.failed=result.failed;state.lastCompletedAt=Date.now();state.iterations++;state.phase=result.failed?'degraded':'running';}
   catch{if(signal.aborted)break;state.phase='degraded';state.failed=Math.max(1,state.failed);}
   const status=launchRecoveryStatus(state).status;
   if(status!==previous){previous=status;onChange({...state});}
   if(once)break;
   await wait(signal);
  }
 }finally{state.phase='stopped';}
}
export function withLaunchRecoveryHealth(base:(req:IncomingMessage,res:ServerResponse)=>void,state:LaunchRecoveryHealth,now=Date.now){
 return (req:IncomingMessage,res:ServerResponse)=>{
  const launch=launchRecoveryStatus(state,now());
  if(req.method==='GET'&&(req.url==='/healthz/launches'||(req.url==='/healthz'&&launch.status!=='ready'))){
   res.statusCode=launch.status==='ready'?200:503;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify({...launch,component:'launch_recovery'}));return;
  }
  base(req,res);
 };
}
