import {VersionedTransaction} from '@solana/web3.js';
import {verifyRaydium22SignedMessage,type Raydium22ExecutionReview,type Raydium22SignedExecution} from './native-copy-review.js';
import {MAINNET_GENESIS} from './solana-network.js';
import type {Rpc} from './funding.js';
export type ControlledExpiry={kind:'expired';signature:string;firstSlot:number;lastSlot:number;lastBlockHeight:number;blocksChecked:number;checkedAt:number};
// A missing transaction/status alone never authorizes another attempt. Walk a
// contiguous finalized block chain from the reviewed blockhash through expiry.
export async function verifyControlledExpiry(r:Raydium22ExecutionReview,hash:string,e:Raydium22SignedExecution,rpc:Rpc):Promise<ControlledExpiry>{
 const fail=():never=>{throw Error('Complete finalized expiry evidence is unavailable.');};
 if(e.reviewHash!==hash||verifyRaydium22SignedMessage(r,hash,e.signed)!==e.signature)return fail();
 if(await rpc('getGenesisHash',[])!==MAINNET_GENESIS)return fail();
 const tx=VersionedTransaction.deserialize(Buffer.from(e.signed,'base64'));
 const head=await rpc('getSlot',[{commitment:'finalized'}]);
 if(!Number.isSafeInteger(head)||Number(head)<=r.minContextSlot)return fail();
 // Simulation can advance minContextSlot beyond the block that supplied the
 // lifetime hash. Find that exact ancestor rather than assuming equal slots.
 let firstSlot=r.minContextSlot;
 for(let i=0;;i++){
  const b=await rpc('getBlock',[firstSlot,{commitment:'finalized',transactionDetails:'signatures',rewards:false,maxSupportedTransactionVersion:1}]) as {blockhash:string;parentSlot:number};
  if(!b||typeof b.blockhash!=='string')return fail();
  if(b.blockhash===tx.message.recentBlockhash)break;
  if(i>=200||!Number.isSafeInteger(b.parentSlot)||b.parentSlot<1||b.parentSlot>=firstSlot||b.parentSlot<r.minContextSlot-400)return fail();
  firstSlot=b.parentSlot;
 }
 const end=Math.min(Number(head),r.minContextSlot+400);
 const slots=await rpc('getBlocks',[firstSlot,end,{commitment:'finalized'}]);
 if(!Array.isArray(slots)||!slots.length||slots[0]!==firstSlot||slots.length>801)return fail();
 let previous:{slot:number;hash:string;height:number}|null=null,count=0;
 for(const slot of slots){
  if(!Number.isSafeInteger(slot)||slot<firstSlot||slot>end||previous&&slot<=previous.slot)return fail();
  const b=await rpc('getBlock',[slot,{commitment:'finalized',transactionDetails:'signatures',rewards:false,maxSupportedTransactionVersion:1}]) as {blockhash:string;previousBlockhash:string;parentSlot:number;blockHeight:number;signatures:string[]};
  if(!b||!Number.isSafeInteger(b.blockHeight)||b.blockHeight<1||typeof b.blockhash!=='string'||
   !Array.isArray(b.signatures)||b.signatures.length>16384||b.signatures.some(s=>typeof s!=='string')||b.signatures.includes(e.signature))return fail();
  if(previous?b.previousBlockhash!==previous.hash||b.parentSlot!==previous.slot||b.blockHeight!==previous.height+1:b.blockhash!==tx.message.recentBlockhash||b.blockHeight>r.lastValidBlockHeight)return fail();
  count++;previous={slot,hash:b.blockhash,height:b.blockHeight};
  if(b.blockHeight>r.lastValidBlockHeight)return {kind:'expired',signature:e.signature,firstSlot,lastSlot:slot,lastBlockHeight:b.blockHeight,blocksChecked:count,checkedAt:Date.now()};
 }
 return fail();
}
