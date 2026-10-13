import {VersionedTransaction} from '@solana/web3.js';
import bs58 from 'bs58';
import {keccak256} from 'viem';
import {isMint} from '../src/assets.js';
import {CASH_NETWORKS,isCashNetwork,type CashNetwork} from '../src/cash-route.js';
import {MAINNET_GENESIS} from './solana-network.js';
import {verifyPrivySignedTransaction} from './privy-sign-only.js';
import {inspectSignedCashEvm,type CashEvmTransaction} from './cash-return-transaction.js';
import type {Rpc} from './funding.js';
export type CashCopyDelivery={version:1;planId:string;jobId:string;wallet:string;network:CashNetwork;expiresAt:number}&({side:'buy';unsigned:string;signed:string;signature:string;slot:number}|{side:'sell';transactions:CashEvmTransaction[];signed:string[];hashes:string[]});
export async function validateCashCopyDelivery(d:CashCopyDelivery,now=Date.now()){
 const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
 if(!d||d.version!==1||!uuid(d.planId)||!uuid(d.jobId)||!isMint(d.wallet)||!isCashNetwork(d.network)||!Number.isSafeInteger(d.expiresAt)||d.expiresAt<=now||d.expiresAt>now+10000)throw Error('Invalid cash delivery.');
 const keys='expiresAt,jobId,network,planId,side,version,wallet'.split(',').concat(d.side==='buy'?['unsigned','signed','signature','slot']:['transactions','signed','hashes']).sort().join(',');
 if(Object.keys(d).sort().join(',')!==keys)throw Error('Unexpected cash delivery fields.');
 if(d.side==='buy'){
  if(typeof d.signed!=='string'||d.signed.length>1644||typeof d.unsigned!=='string'||d.unsigned.length>1644||!Number.isSafeInteger(d.slot)||d.slot<1)throw Error('Invalid cash purchase delivery.');
  verifyPrivySignedTransaction(d.unsigned,d.signed,d.wallet);
  const tx=VersionedTransaction.deserialize(Buffer.from(d.signed,'base64'));if(bs58.encode(tx.signatures[0])!==d.signature)throw Error('Cash purchase signature changed.');
 }else if(d.side==='sell'){
  if(!Array.isArray(d.transactions)||!Array.isArray(d.signed)||!Array.isArray(d.hashes)||d.signed.length<1||d.signed.length>2||d.transactions.length!==d.signed.length||d.hashes.length!==d.signed.length)throw Error('Invalid cash sale delivery.');
  for(let i=0;i<d.signed.length;i++){
   if(d.transactions[i].chainId!==CASH_NETWORKS[d.network].chainId||d.transactions[i].value!=='0'||i>0&&(d.transactions[i].from!==d.transactions[0].from||d.transactions[i].nonce!==d.transactions[i-1].nonce+1)||typeof d.signed[i]!=='string'||d.signed[i].length>140000)throw Error('Cash sale transaction changed.');
   await inspectSignedCashEvm(d.transactions[i],d.signed[i]);if(keccak256(d.signed[i] as `0x${string}`)!==d.hashes[i])throw Error('Cash sale hash changed.');
  }
 }else throw Error('Invalid cash delivery side.');
}
// Executor only. The private host hands over immutable, already-authorized
// bytes for a few seconds. It does not expose keys or grant construction.
export async function submitCashCopyDelivery(d:CashCopyDelivery,c:{solana:Rpc;evm:(network:CashNetwork)=>Rpc;broadcast:(signed:string,network:CashNetwork)=>Promise<unknown>;enabled:()=>boolean},signal:AbortSignal){
 await validateCashCopyDelivery(d);signal.throwIfAborted();if(!c.enabled())throw Error('Cash copying is paused.');
 if(d.side==='buy'){
  if(await c.solana('getGenesisHash',[])!==MAINNET_GENESIS)throw Error('Wrong source network.');
  const tx=VersionedTransaction.deserialize(Buffer.from(d.signed,'base64'));
  const valid=await c.solana('isBlockhashValid',[tx.message.recentBlockhash,{commitment:'finalized',minContextSlot:d.slot}]) as any;
  if(valid?.value!==true||!Number.isSafeInteger(valid.context?.slot)||valid.context.slot<d.slot)throw Error('Cash deposit expired or unavailable.');
  await validateCashCopyDelivery(d);signal.throwIfAborted();if(!c.enabled())throw Error('Cash copying is paused.');
  const result=await c.solana('sendTransaction',[d.signed,{encoding:'base64',skipPreflight:false,maxRetries:0,preflightCommitment:'finalized',minContextSlot:d.slot}]);
  if(result!==d.signature)throw Error('Cash purchase submission is unresolved.');
 }else{
  const rpc=c.evm(d.network),chain=await rpc('eth_chainId',[]);
  if(typeof chain!=='string'||!/^0x[0-9a-f]+$/i.test(chain)||BigInt(chain)!==BigInt(CASH_NETWORKS[d.network].chainId))throw Error('Wrong destination network.');
  for(let i=0;i<d.signed.length;i++){
   await validateCashCopyDelivery(d);signal.throwIfAborted();if(!c.enabled())throw Error('Cash copying is paused.');
   const existing=await rpc('eth_getTransactionReceipt',[d.hashes[i]]) as any;
   if(existing){if(existing.transactionHash?.toLowerCase()!==d.hashes[i]||existing.status!=='0x1')throw Error('Cash sale needs recovery.');continue;}
   const result=await c.broadcast(d.signed[i],d.network);if(result!==d.hashes[i])throw Error('Cash sale submission is unresolved.');
  }
 }
 return {state:'submitted' as const,planId:d.planId,jobId:d.jobId};
}
