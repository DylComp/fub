import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import canonicalize from 'canonicalize';
import {readPrivateTestFile} from './controlled-leader-files.js';
import {controlledTestPolicy,validateLeaderTestState,type LeaderTestState,type ControlledCarryover} from './controlled-leader-test.js';
import {recoverRaydium22Execution} from './token2022-recovery.js';
import type {Rpc} from './funding.js';

export function controlledStateHash(s:LeaderTestState){return createHash('sha256').update(canonicalize(s)!).digest('hex');}
export function controlledPriorAttempts(c?:ControlledCarryover){
 return c?.additional?[{executionId:c.executionId,jobId:c.jobId},{executionId:c.additional.executionId,jobId:c.additional.jobId}]:[];
}
export function verifyControlledCarryover(parent:LeaderTestState,current:LeaderTestState,additional?:LeaderTestState){
 const c=current.carryover;validateLeaderTestState(current,controlledTestPolicy('50000'));
 validateLeaderTestState(parent,controlledTestPolicy('50000'));
 if(!c||parent.carryover||parent.leader!==current.leader||controlledStateHash(parent)!==c.parentStateHash||parent.attempts.length!==1)throw Error('Carryover journal changed.');
 const a=parent.attempts[0],o=a.outcome;
 if(a.side!=='buy'||!a.execution||!a.submissionClaimed||o?.kind!=='succeeded'||o.inputRaw!=='50000')throw Error('Carryover debit changed.');
 let spent=BigInt(o.inputRaw)+BigInt(o.feeLamports)+BigInt(o.rentLamports),tokens=BigInt(o.outputRaw),last=a;
 if(c.additional){
  if(!additional||additional.carryover?.additional||controlledStateHash(additional)!==c.additional.stateHash||additional.attempts.length!==1||
    additional.carryover?.parentRun!==c.parentRun||additional.carryover?.planId!==c.planId||additional.carryover?.executionId!==c.executionId||additional.carryover?.jobId!==c.jobId)
   throw Error('Additional carryover changed.');
  verifyControlledCarryover(parent,additional);
  const next=additional.attempts[0],r=next.outcome;
  if(next.side!=='buy'||!next.execution||!next.submissionClaimed||r?.kind!=='succeeded'||r.inputRaw!=='50000'||next.execution.signature===a.execution.signature)
   throw Error('Additional carryover receipt is not a distinct successful buy.');
  spent+=BigInt(r.inputRaw)+BigInt(r.feeLamports)+BigInt(r.rentLamports);tokens+=BigInt(r.outputRaw);last=next;
 }else if(additional)throw Error('Unexpected carryover journal.');
 if(spent!==BigInt(c.spentLamports)||tokens!==BigInt(c.tokensRaw))throw Error('Carryover debit changed.');
 return last;
}
// A separately approved continuation may use the remaining original funding
// only after the former child is closed and every one of its buys is proven
// expired. Its journal remains immutable and contributes exactly zero debit.
export function verifyClosedCarryoverChild(parent:LeaderTestState,prior:LeaderTestState,closure:{completed?:boolean;dispatchDisabled?:boolean;signerDisabled?:boolean;closureVerified?:boolean}){
 verifyControlledCarryover(parent,prior);
 if(closure.completed!==false||closure.dispatchDisabled!==true||closure.signerDisabled!==true||closure.closureVerified!==true||
   prior.attempts.length!==2||prior.attempts.some(a=>a.side!=='buy'||!a.execution||!a.submissionClaimed||a.outcome?.kind!=='expired'))
  throw Error('Previous controlled cycle is not closed with zero debit.');
 return controlledStateHash(prior);
}
// Read the original journal on every command. A durable one-child claim avoids
// creating several fresh journals against the same already-spent test budget.
export async function readControlledCarryover(directory:string,state:LeaderTestState,run:string|undefined,rpc?:Rpc){
 if(!state.carryover)return null;
 validateLeaderTestState(state,controlledTestPolicy('50000'));
 const c=state.carryover,parentDir=join(dirname(directory),c.parentRun);
 const claim=await readPrivateTestFile(join(parentDir,'carryover-child.json'));
 if(!run||claim.run!==(c.additional?.run??run)||claim.parentStateHash!==c.parentStateHash)throw Error('Carryover already assigned.');
 const parent=await readPrivateTestFile(join(parentDir,'state.json')) as LeaderTestState;
 let additional:LeaderTestState|undefined;
 if(c.additional){
  const dir=join(dirname(directory),c.additional.run);
  const nextClaim=await readPrivateTestFile(join(dir,'carryover-child.json'));
  const closed=nextClaim.closure;
  if(nextClaim.run!==run||nextClaim.parentStateHash!==c.additional.stateHash||closed?.completed!==false||closed?.dispatchDisabled!==true||closed?.signerDisabled!==true||closed?.closureVerified!==true)
   throw Error('Additional cycle is not closed or is already assigned.');
  additional=await readPrivateTestFile(join(dir,'state.json'));
 }
 const attempt=verifyControlledCarryover(parent,state,additional);
 if(claim.previous){
  // One explicitly approved continuation, not an unbounded retry chain.
  const p=claim.previous;
  if(!/^[a-z][a-z0-9-]{0,59}$/.test(p.run)||[run,c.parentRun].includes(p.run)||!/^[a-f0-9]{64}$/.test(p.stateHash))throw Error('Invalid prior cycle.');
  const old=await readPrivateTestFile(join(dirname(directory),p.run,'state.json'));
  if(verifyClosedCarryoverChild(parent,old,p.closure)!==p.stateHash)throw Error('Prior cycle changed.');
 }
 if(rpc)for(const saved of additional?[parent.attempts[0],attempt]:[attempt]){
  const actual=await recoverRaydium22Execution(saved.review,saved.reviewHash,saved.execution!,rpc);
  if(canonicalize(actual)!==canonicalize(saved.outcome))throw Error('Carryover receipt changed.');}
 return {directory:parentDir,carryover:c,attempt};
}

// A partial leader sale must debit the same fraction of this plan's acquired
// position. Pre-existing leader holdings must not silently become copied buys.
export function controlledExpectedPosition(rows:{side:string;settlement:string|null;credited_raw:string;input_raw:string}[],carryover?:ControlledCarryover,newLeaderBuyRaw?:string){
 if(!rows.length)return null;
 const [buy,sell]=rows;if(rows.length>2||buy.side!=='buy'||buy.settlement!=='succeeded')return null;
 const owned=BigInt(buy.credited_raw);if(owned<=0n)return null;
 if(!sell)return owned.toString();
 if(sell.side!=='sell'||sell.settlement!=='succeeded')return null;
 const sold=BigInt(sell.input_raw);
 if(sold<=0n||sold>owned||!carryover&&sold!==owned)return null;
 if(carryover){
  if(!newLeaderBuyRaw||! /^[1-9][0-9]*$/.test(newLeaderBuyRaw))return null;
  const leaderNew=BigInt(newLeaderBuyRaw),expected=owned*leaderNew/(BigInt(carryover.tokensRaw)+leaderNew);
  if(sold!==expected)return null;
 }
 return (owned-sold).toString();
}
