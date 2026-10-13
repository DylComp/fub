import {setTimeout as delay} from 'node:timers/promises';
import { PublicKey, type Connection } from '@solana/web3.js';
import { launchPacket, verifyLaunchSigned, launchPlanHash, type LaunchExecutionPlan } from './launch-execution-model.js';
import { MAINNET_GENESIS } from './solana-network.js';
export type LaunchNonlandingProof={signature:string;planHash:string;firstSlot:number;lastSlot:number;lastBlockHeight:number;blocksChecked:number;mintAbsentSlot:number;checkedAt:number};
export function validateLaunchNonlanding(p:LaunchExecutionPlan,signature:string,proof:LaunchNonlandingProof){
 if(proof.signature!==signature||proof.planHash!==launchPlanHash(p)||![proof.firstSlot,proof.lastSlot,proof.lastBlockHeight,proof.blocksChecked,proof.mintAbsentSlot,proof.checkedAt].every(n=>Number.isSafeInteger(n)&&n>0)||proof.firstSlot>p.contextSlot||proof.firstSlot<p.contextSlot-400||proof.lastSlot<proof.firstSlot||proof.lastBlockHeight<=p.lastValidBlockHeight||proof.blocksChecked>401||proof.blocksChecked<2||proof.mintAbsentSlot<proof.lastSlot||proof.checkedAt>Date.now()+30000)throw Error('Invalid finalized launch nonlanding proof.');
}
// A null signature lookup is insufficient. Verify every linked finalized block
// from the exact lifetime hash through expiration, then prove mint absence.
export async function proveLaunchNonlanding(p:LaunchExecutionPlan,signed:string,c:Connection):Promise<LaunchNonlandingProof>{
 const signature=verifyLaunchSigned(p,signed), hash=launchPacket(p.unsigned).message.recentBlockhash;
 const fail=():never=>{throw Error('Complete finalized launch expiry evidence unavailable.');};
 if(await c.getGenesisHash()!==MAINNET_GENESIS)return fail();
 const head=await c.getSlot('finalized');if(!Number.isSafeInteger(head)||head<=p.contextSlot)return fail();
 const deadline=Date.now()+45000;
 const block=async(slot:number)=>{if(Date.now()>deadline)return fail();return await c.getBlockSignatures(slot,'finalized') as Awaited<ReturnType<Connection['getBlockSignatures']>>&{blockHeight:number|null};};
 let first=p.contextSlot;
 for(let i=0;;i++){
  const b=await block(first);if(!b)return fail();if(b.blockhash===hash)break;
  if(i>=200||!Number.isSafeInteger(b.parentSlot)||b.parentSlot<1||b.parentSlot>=first||b.parentSlot<p.contextSlot-400)return fail();first=b.parentSlot;
 }
 const slots=await c.getBlocks(first,Math.min(head,p.contextSlot+400),'finalized');
 if(!slots.length||slots[0]!==first||slots.length>801)return fail();
 let prev:{slot:number;hash:string;height:number}|null=null,count=0;
 for(let offset=0;offset<slots.length;offset+=2){
  if(offset)await delay(300);
  const batch=slots.slice(offset,offset+2),blocks=await Promise.all(batch.map(block));
  for(let i=0;i<batch.length;i++){
   const slot=batch[i],b=blocks[i];if(!Number.isSafeInteger(slot)||slot<first||prev&&slot<=prev.slot||!b||!Number.isSafeInteger(b.blockHeight)||!b.blockHeight||!Array.isArray(b.signatures)||b.signatures.length>16384||b.signatures.some(s=>typeof s!=='string')||b.signatures.includes(signature))return fail();
   if(prev?b.parentSlot!==prev.slot||b.previousBlockhash!==prev.hash||b.blockHeight!==prev.height+1:b.blockhash!==hash||b.blockHeight>p.lastValidBlockHeight)return fail();
   count++;prev={slot,hash:b.blockhash,height:b.blockHeight};
   if(b.blockHeight>p.lastValidBlockHeight){
    const mint=await c.getAccountInfoAndContext(new PublicKey(p.mint),{commitment:'finalized',minContextSlot:slot});
    if(mint.value!==null||mint.context.slot<slot)return fail();
    const proof={signature,planHash:launchPlanHash(p),firstSlot:first,lastSlot:slot,lastBlockHeight:b.blockHeight,blocksChecked:count,mintAbsentSlot:mint.context.slot,checkedAt:Date.now()};validateLaunchNonlanding(p,signature,proof);return proof;
   }
  }
 }
 return fail();
}
