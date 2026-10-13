import {randomUUID} from 'node:crypto';
import {verifyDirectExitRecord} from './direct-exit-settlement.js';
import type {DirectExitStore} from './direct-exit-store.js';
import type {EnrolledWallet} from './signer-enrollment.js';
import type {Rpc} from './funding.js';
import {MAINNET_GENESIS} from './solana-network.js';
import {getTransactionDecoder,getCompiledTransactionMessageDecoder,address} from '@solana/kit';
import {isMint} from '../src/assets.js';
import bs58 from 'bs58';
import {createPublicKey,verify} from 'node:crypto';
export type ExitDelivery={version:1;id:string;attemptId:string;deliveryId:string;wallet:string;signed:string;signature:string;expiresAt:number;minContextSlot:number;lastValidBlockHeight:number};
// Private journal -> bounded executor handoff. This host never broadcasts.
export function directExitDelivery(config:{assertTerms?:(terms:import('../src/direct-exits.js').DirectExitTerms)=>void;origin:string;store:DirectExitStore;enabled:()=>boolean;allows:(wallet:string)=>boolean;resolveWallet:(wallet:string,issuedAt:number,signal:AbortSignal)=>Promise<EnrolledWallet>}){
 return async(signal:AbortSignal):Promise<ExitDelivery|null>=>{
  if(!config.enabled())return null;
  for(const row of await config.store.deliveries()){
   signal.throwIfAborted();
   if(!config.allows(row.terms.wallet))continue;
   try{config.assertTerms?.(row.terms);}catch{continue;}
   const review=verifyDirectExitRecord(row,config.origin),t=row.terms;
   if(t.expiresAt<=Date.now()||review.intent.expiresAt<=Date.now())continue;
   const owner=await config.resolveWallet(t.wallet,t.issuedAt,signal);await owner.check(signal);
   signal.throwIfAborted();if(!config.enabled()||!config.allows(t.wallet))return null;
   const expiresAt=Math.min(Date.now()+8000,t.expiresAt,review.intent.expiresAt),deliveryId=randomUUID();
   if(expiresAt<=Date.now()+250)continue;
   if(!await config.store.claimDelivery(row,deliveryId,expiresAt))continue;
   await owner.check(signal);signal.throwIfAborted();if(!config.enabled()||!config.allows(t.wallet))return null;
   config.assertTerms?.(t);
   return {version:1,id:t.id,attemptId:row.attemptId!,deliveryId,wallet:t.wallet,signed:row.signed!,signature:row.transactionSignature!,expiresAt,minContextSlot:row.watermark.slot,lastValidBlockHeight:review.lifetime.lastValidBlockHeight};
  }
  return null;
 };
}
export function validateExitDelivery(d:ExitDelivery,now=Date.now()){
 const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
 if(!d||Object.keys(d).sort().join(',')!=='attemptId,deliveryId,expiresAt,id,lastValidBlockHeight,minContextSlot,signature,signed,version,wallet'||d.version!==1||![d.id,d.attemptId,d.deliveryId].every(x=>typeof x==='string'&&uuid.test(x))||!isMint(d.wallet)||
 !Number.isSafeInteger(d.expiresAt)||d.expiresAt<=now||d.expiresAt>now+10000||!Number.isSafeInteger(d.minContextSlot)||d.minContextSlot<1||!Number.isSafeInteger(d.lastValidBlockHeight)||d.lastValidBlockHeight<1||typeof d.signed!=='string'||d.signed.length>1644)throw Error('Invalid exit delivery.');
 const bytes=Buffer.from(d.signed,'base64');if(bytes.toString('base64')!==d.signed||bytes.length>1232)throw Error('Invalid exit transaction.');
 const tx=getTransactionDecoder().decode(bytes),message=getCompiledTransactionMessageDecoder().decode(tx.messageBytes),signature=tx.signatures[address(d.wallet)];
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),bs58.decode(d.wallet)]),format:'der',type:'spki'});
 if(message.version!==0||message.header.numSignerAccounts!==1||message.staticAccounts[0]!==d.wallet||Object.keys(tx.signatures).join()!==d.wallet||!signature||bs58.encode(signature)!==d.signature||!verify(null,tx.messageBytes,key,signature))throw Error('Exit signature mismatch.');
 return message;
}
// Executor-only transport. Retrying can only broadcast the exact same bytes and
// signature. No signer key or private ledger credential is available here.
export async function submitDirectExit(d:ExitDelivery,rpc:Rpc,signal:AbortSignal){
 const message=validateExitDelivery(d);signal.throwIfAborted();
 if(await rpc('getGenesisHash',[])!==MAINNET_GENESIS)throw Error('Exit submission requires mainnet.');
 const valid=await rpc('isBlockhashValid',[message.lifetimeToken,{commitment:'finalized',minContextSlot:d.minContextSlot}]) as any;
 if(valid?.value!==true||!Number.isSafeInteger(valid?.context?.slot)||valid.context.slot<d.minContextSlot)throw Error('Exit blockhash is unavailable.');
 const height=await rpc('getBlockHeight',[{commitment:'finalized',minContextSlot:d.minContextSlot}]);
 if(!Number.isSafeInteger(height)||(height as number)>d.lastValidBlockHeight)throw Error('Exit blockhash expired.');
 signal.throwIfAborted();validateExitDelivery(d);
 // maxRetries=0: the relay owns retry timing; providers must not queue beyond consent.
 const result=await rpc('sendTransaction',[d.signed,{encoding:'base64',skipPreflight:false,preflightCommitment:'confirmed',maxRetries:0,minContextSlot:d.minContextSlot}]);
 if(result!==d.signature)throw Error('Exit submission result is uncertain; recover the existing signature.');
 return {signature:d.signature};
}
