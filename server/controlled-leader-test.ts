// Operator-only acceptance tooling. No web route imports this module.
// The leader trades on chain; production copying must observe its real receipts.
import {createHash} from 'node:crypto';
import {type ExecutorRpcDiagnostic} from './copy-executor-rpc.js';
import {preflightToken22} from './token2022-preflight.js';
import {broadcastNativeTransaction} from './native-broadcast.js';
import {isMint} from '../src/assets.js';
import {WSOL} from '../src/funding-model.js';
import {nativeSellWithoutSetup} from './native-pilot-policy.js';
import {raydium22ReviewHash,verifyRaydium22Review,bindRaydium22Signed,
  recoverRaydium22Execution,type Raydium22ExecutionReview,type Raydium22SignedExecution} from './native-copy-review.js';
import type {Rpc} from './funding.js';
import {getTransactionDecoder,getCompiledTransactionMessageDecoder} from '@solana/kit';
import {COPY_SWAP_PROGRAM,decodeCopyRoute} from '../src/copy-swap.js';
import {verifyControlledExpiry,type ControlledExpiry} from './controlled-leader-expiry.js';

export const CONTROLLED_TEST = Object.freeze({
  follower:'2SCiPp8ZHFsooXVR74SQxqPP3X6R3XcX2e69iBhSs5Tr',
  mint:'98kfF7rmsg1QDUEoCqNE7g7M1FdrTt92TEp2CLzypump',
  buyLamports:'100000',leaderDebitCap:'4000000',followerDebitCap:'4000000',
  fundingFeeCap:'10000',slippageBps:100,
});
export type ControlledTestPolicy=Omit<typeof CONTROLLED_TEST,'buyLamports'|'mint'|'leaderDebitCap'>&{readonly buyLamports:string;readonly mint:string;readonly leaderDebitCap:'4000000'|'5000000';readonly venue?:'pump-curve'|'pumpswap'|'raydium-standard'};
export function controlledTestPolicy(buyLamports=CONTROLLED_TEST.buyLamports as string,spec?:{mint:string;venue:'pump-curve'|'pumpswap'|'raydium-standard'}):ControlledTestPolicy{
 if(!/^[1-9][0-9]{0,5}$/.test(buyLamports)||BigInt(buyLamports)>100000n)throw Error('Invalid controlled buy amount.');
 if(spec&&(Object.keys(spec).sort().join(',')!=='mint,venue'||!isMint(spec.mint)||[WSOL,CONTROLLED_TEST.follower].includes(spec.mint)||!['pump-curve','pumpswap','raydium-standard'].includes(spec.venue)))throw Error('Invalid test venue.');
 return Object.freeze({...CONTROLLED_TEST,buyLamports,...spec,leaderDebitCap:spec?.venue==='pumpswap'?'5000000':'4000000'});
}
export function controlledOwnerOutflowCap(policy:ControlledTestPolicy):string{
 return (BigInt(policy.leaderDebitCap)+BigInt(policy.followerDebitCap)+BigInt(policy.fundingFeeCap)).toString();
}
type Outcome = Awaited<ReturnType<typeof recoverRaydium22Execution>>|ControlledExpiry;
export type LeaderAttempt = {
  side:'buy'|'sell';review:Raydium22ExecutionReview;reviewHash:string;reservedLamports:string;
  execution:Raydium22SignedExecution|null;submissionClaimed:boolean;outcome:Outcome|null;
  submissionResponse?:{kind:'accepted'|'unknown';diagnostic?:ExecutorRpcDiagnostic};
};
export type ControlledCarryover = {parentRun:string;parentStateHash:string;spentLamports:string;tokensRaw:string;executionId:string;jobId:string;planId:string;
 additional?:{run:string;stateHash:string;executionId:string;jobId:string}};
export type ClosedTestCycle = {parentRun:string;parentStateHash:string;spentLamports:string;balanceCreditLamports:string;planId:string;previousPlanId?:string;priorAttempts:{jobId:string;executionId:string|null}[]};
export type LeaderTestState = {version:1;leader:string;attempts:LeaderAttempt[];carryover?:ControlledCarryover;closedCycle?:ClosedTestCycle};
export const controlledPriorDebit=(s:LeaderTestState)=>s.closedCycle?.spentLamports??s.carryover?.spentLamports??'0';
export type LeaderTestApproval = {version:1;leader:string;follower:string;mint:string;
  buyLamports:string;leaderDebitCap:string;slippageBps:number;expiresAt:number;reference:string};
export type LeaderTestStore = {
  // Must exclusively hold the lock through all network/sign/persistence work.
  exclusive<T>(work:(state:LeaderTestState,save:(next:LeaderTestState)=>Promise<void>)=>Promise<T>):Promise<T>;
};
type Dependencies = {
  store:LeaderTestStore;
  build:(side:'buy'|'sell',inputRaw:string)=>Promise<Raydium22ExecutionReview>;
  // Must recheck the exact signed follower plan, private pilot, observer and
  // dispatch gates. For sells it must confirm the follower's matching buy.
  followerReady:(leader:string,side:'buy'|'sell')=>Promise<void>;
  sign:(unsigned:string)=>Promise<string>;
  rpc:Rpc;
  recoverRpc:Rpc;
  expiryRpc?:Rpc;
  now?:()=>number;
  progress?:(stage:'signing'|'signed-preflight'|'send-claim'|'broadcast')=>void;
};
const refused=()=>{throw Error('Controlled test refused. Check its approval, journal and follower readiness.');};
const raw=(v:unknown)=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)?BigInt(v):refused();
export function validateLeaderTestState(s:LeaderTestState,policy:ControlledTestPolicy=CONTROLLED_TEST){
  if(s.version!==1||!isMint(s.leader)||[policy.follower,policy.mint,WSOL].includes(s.leader)||
    !Array.isArray(s.attempts)||s.attempts.length>4)return refused();
  if(s.closedCycle&&(s.carryover||!/^[a-z][a-z0-9-]{0,59}$/.test(s.closedCycle.parentRun)||!/^[a-f0-9]{64}$/.test(s.closedCycle.parentStateHash)||raw(s.closedCycle.spentLamports)<1n||raw(s.closedCycle.spentLamports)>=raw(policy.leaderDebitCap)||!['0','100000'].includes(s.closedCycle.balanceCreditLamports)||! /^[a-f0-9-]{36}$/.test(s.closedCycle.planId)||!Array.isArray(s.closedCycle.priorAttempts)||(s.closedCycle.previousPlanId!==undefined?(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s.closedCycle.previousPlanId)||s.closedCycle.previousPlanId===s.closedCycle.planId||s.closedCycle.priorAttempts.length!==0):s.closedCycle.priorAttempts.length!==1)||s.closedCycle.priorAttempts.some(a=>! /^[a-f0-9-]{36}$/.test(a.jobId)||a.executionId!==null&&! /^[a-f0-9-]{36}$/.test(a.executionId))))return refused();
  if(s.carryover&&(!/^[a-z][a-z0-9-]{0,59}$/.test(s.carryover.parentRun)||! /^[a-f0-9]{64}$/.test(s.carryover.parentStateHash)||
    raw(s.carryover.spentLamports)<1n||raw(s.carryover.spentLamports)>=raw(policy.leaderDebitCap)||raw(s.carryover.tokensRaw)<1n||
    [s.carryover.executionId,s.carryover.jobId,s.carryover.planId].some(id=>! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))))return refused();
  if(s.carryover?.additional){const a=s.carryover.additional;
   if(!/^[a-z][a-z0-9-]{0,59}$/.test(a.run)||a.run===s.carryover.parentRun||! /^[a-f0-9]{64}$/.test(a.stateHash)||
    [a.executionId,a.jobId].some(id=>! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))||
    a.executionId===s.carryover.executionId||a.jobId===s.carryover.jobId)return refused();
  }
  for(const [i,a]of s.attempts.entries()){
    const side=i===0||i===1&&s.attempts[0].outcome?.kind==='expired'?'buy':'sell';
    if(i===2&&s.attempts[0].outcome?.kind!=='expired'&&s.attempts[1].outcome?.kind!=='expired'||i===3&&(s.attempts[0].outcome?.kind!=='expired'||s.attempts[2].outcome?.kind!=='expired'))return refused();
    if(a.side!==side||a.review.accounts.wallet!==s.leader||a.review.accounts.mint!==policy.mint||a.review.accounts.direction!==a.side||
      typeof a.submissionClaimed!=='boolean'||(a.submissionClaimed&&!a.execution))return refused();
    if(a.outcome?.kind==='expired'&&(!a.execution||a.outcome.signature!==a.execution.signature||a.outcome.firstSlot>a.review.minContextSlot||a.outcome.lastBlockHeight<=a.review.lastValidBlockHeight||a.outcome.blocksChecked<2))return refused();
    verifyRaydium22Review(a.review,a.reviewHash);
    if(a.side==='sell'&&!policy.venue&&raw(a.review.accounts.inputRaw)>1000000n||policy.venue==='pump-curve'&&a.review.version!==4||policy.venue==='pumpswap'&&![3,5].includes(a.review.version))return refused();
    if(raw(a.reservedLamports)>raw(policy.leaderDebitCap))return refused();
    if(a.side==='buy'&&a.review.accounts.inputRaw!==policy.buyLamports)return refused();
    if(a.side==='sell'&&!nativeSellWithoutSetup(a.review))return refused();
  }
}
export function replaceableExpiredBuy(s:LeaderTestState,policy:ControlledTestPolicy=CONTROLLED_TEST):boolean {
 validateLeaderTestState(s,policy);
 const a=s.attempts[0];
 return s.attempts.length===1 && a.side==='buy' && a.submissionClaimed && !!a.execution && a.outcome?.kind==='expired';
}
// Preserve expired submissions in the journal. At most one proven expired
// attempt per side can be omitted when reviewing replacement receipts.
export async function controlledActiveAttempts(s:LeaderTestState,policy:ControlledTestPolicy,rpc:Rpc,proofs?:Map<string,ControlledExpiry>):Promise<LeaderAttempt[]> {
 validateLeaderTestState(s,policy);
 const expired={buy:0,sell:0};
 for(const a of s.attempts) {
  if(a.outcome?.kind!=='expired')continue;
  if(++expired[a.side]>1||!a.submissionClaimed||!a.execution)return refused();
  const key=createHash('sha256').update(JSON.stringify([a.review,a.reviewHash,a.execution])).digest('hex');
  const proof=proofs?.get(key)??await verifyControlledExpiry(a.review,a.reviewHash,a.execution,rpc);
  if(proofs&&!proofs.has(key)){if(proofs.size>=4)proofs.clear();proofs.set(key,proof);}
  if(proof.signature!==a.outcome.signature)return refused();
 }
 return s.attempts.filter(a=>a.outcome?.kind!=='expired');
}
export function replaceableExpiredSell(s:LeaderTestState,policy:ControlledTestPolicy=CONTROLLED_TEST):boolean {
 validateLeaderTestState(s,policy);
 const buys=s.attempts.filter(a=>a.side==='buy'&&a.outcome?.kind!=='expired'),sells=s.attempts.filter(a=>a.side==='sell');
 return buys.length===1&&buys[0].outcome?.kind==='succeeded'&&sells.length===1&&sells[0].outcome?.kind==='expired'&&sells[0].submissionClaimed&&!!sells[0].execution;
}
function approvalFor(a:LeaderTestApproval,leader:string,now:number,policy:ControlledTestPolicy){
 if(!a||a.version!==1||a.leader!==leader||a.follower!==policy.follower||a.mint!==policy.mint||
   a.buyLamports!==policy.buyLamports||a.leaderDebitCap!==policy.leaderDebitCap||a.slippageBps!==100||
   !Number.isSafeInteger(a.expiresAt)||a.expiresAt<=now||a.expiresAt>now+86400000||
   typeof a.reference!=='string'||a.reference.length<8||a.reference.length>200)return refused();
}
const debit=(a:LeaderAttempt)=>a.outcome?.kind==='succeeded'
 ?raw(a.outcome.feeLamports)+raw(a.outcome.rentLamports)+(a.side==='buy'?raw(a.outcome.inputRaw):0n)
 :a.outcome?.kind==='failed'?raw(a.outcome.feeLamports):a.outcome?.kind==='expired'?0n:raw(a.reservedLamports);

export function controlledLeaderTest(d:Dependencies,policy:ControlledTestPolicy=CONTROLLED_TEST){
 const now=d.now??Date.now;
 return {
  async execute(side:'buy'|'sell',approval:LeaderTestApproval){
   return d.store.exclusive(async(s,save)=>{
    validateLeaderTestState(s,policy);approvalFor(approval,s.leader,now(),policy);
    const buys=s.attempts.filter(a=>a.side==='buy');
    if(side==='buy'?s.attempts.length>1||s.attempts.length===1&&s.attempts[0].outcome?.kind!=='expired':side!=='sell'||!buys.length||s.attempts.some(a=>a.side==='sell')&&!replaceableExpiredSell(s,policy))return refused();
    const buy=buys.at(-1)!;
    if(side==='sell'&&(buy.outcome?.kind!=='succeeded'||!buy.execution))return refused();
    const input=side==='buy'?policy.buyLamports:(buy.outcome as Extract<Outcome,{kind:'succeeded'}>).outputRaw;
    if(raw(input)<1n||side==='sell'&&raw(input)>(policy.venue==='pump-curve'?18446744073709551615n:1000000n))return refused();
    await d.followerReady(s.leader,side);
    const review=await d.build(side,input),hash=raydium22ReviewHash(review);
    verifyRaydium22Review(review,hash);
    if(policy.venue==='pump-curve'){if(review.version!==4||!review.curve||review.curve.request.slippageBps>policy.slippageBps)return refused();}
    else {
    if(policy.venue==='raydium-standard'&&review.version!==2||policy.venue==='pumpswap'&&![3,5].includes(review.version))return refused();
    const message=getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(review.unsigned,'base64')).messageBytes);
    if(message.version!==0)return refused();
    const swaps=message.instructions.filter(i=>message.staticAccounts[i.programAddressIndex]===COPY_SWAP_PROGRAM);
    if(swaps.length!==1||!swaps[0].data)return refused();
    const route=decodeCopyRoute(Uint8Array.from(swaps[0].data));
    if(route.kind!=='direct'||route.intermediateNode!==undefined||route.steps.some(s=>policy.venue==='pumpswap'?s.variant!==(review.version===5?(side==='buy'?193:194):(side==='buy'?99:100)):policy.venue==='raydium-standard'?![26,40].includes(s.variant):s.variant!==40)||route.input!==raw(input)||
      route.slippageBps>100||route.slippageBps<10||raw(review.accounts.minimum)!==route.output*BigInt(10000-route.slippageBps)/10000n)return refused();
    }
    if(review.accounts.wallet!==s.leader||review.accounts.mint!==policy.mint||review.accounts.direction!==side||
      review.accounts.inputRaw!==input||review.expiresAt<=now()||review.expiresAt>approval.expiresAt||review.reviewedAt>now()||
      review.feeLamports>10000||side==='sell'&&!nativeSellWithoutSetup(review))return refused();
    // Rent is never offset by sale proceeds. Retain unknown-attempt reservations.
    const reserved=BigInt(review.feeLamports)+(side==='buy'?raw(input)+(review.wrappedCreated?raw(review.wrappedReserve):0n)+BigInt(review.tokenRent)+BigInt(review.pumpTracker?.rent??0)+BigInt(review.curve?.trackerRent??0)+BigInt(review.curve?.curveRent??0):0n);
    if(reserved+s.attempts.reduce((n,a)=>n+debit(a),raw(controlledPriorDebit(s)))>raw(policy.leaderDebitCap))return refused();
    const attempt:LeaderAttempt={side,review,reviewHash:hash,reservedLamports:reserved.toString(),execution:null,submissionClaimed:false,outcome:null};
    s.attempts.push(attempt);await save(s); // Claim before signing, including failed/uncertain attempts.
    approvalFor(approval,s.leader,now(),policy);await d.followerReady(s.leader,side);
    const height=await d.rpc('getBlockHeight',[{commitment:'finalized'}]);
    if(!Number.isSafeInteger(height)||Number(height)>review.lastValidBlockHeight)return refused();
    d.progress?.('signing');
    const signed=await d.sign(review.unsigned);
    attempt.execution=bindRaydium22Signed(review,hash,signed,Number(height),now());await save(s);
    // Recheck after signing. A failed check retains bytes but grants no send.
    approvalFor(approval,s.leader,now(),policy);await d.followerReady(s.leader,side);
    // Run this after the remote owner checks so they cannot consume the short
    // preflight lifetime. This is the production exact-signature/balance check.
    d.progress?.('signed-preflight');
    const preflight=await preflightToken22({state:'signed',review,reviewHash:hash,execution:attempt.execution},d.rpc);
    approvalFor(approval,s.leader,now(),policy);
    if(now()>=review.expiresAt||Date.now()-preflight.checkedAt>5000)return refused();
    bindRaydium22Signed(review,hash,signed,preflight.blockHeight,now());
    d.progress?.('send-claim');
    attempt.submissionClaimed=true;await save(s); // A crash/timeout cannot grant a second send.
    d.progress?.('broadcast');
    const result=await broadcastNativeTransaction(d.rpc,signed,attempt.execution.signature,preflight.slot);
    attempt.submissionResponse=result.kind==='accepted'?{kind:'accepted'}:{kind:'unknown',diagnostic:result.diagnostic};
    await save(s);
    return {kind:result.kind==='accepted'?'submitted' as const:'uncertain' as const,signature:attempt.execution.signature};
   });
  },
  async recover(){
   return d.store.exclusive(async(s,save)=>{
    validateLeaderTestState(s,policy);
    for(const a of s.attempts){
      if(!a.execution||a.outcome?.kind==='succeeded'||a.outcome?.kind==='failed'||a.outcome?.kind==='expired')continue;
      a.outcome=await recoverRaydium22Execution(a.review,a.reviewHash,a.execution,d.recoverRpc);
      await save(s);
    }
    return {leader:s.leader,attempts:s.attempts.map(a=>({side:a.side,signature:a.execution?.signature??null,submitted:a.submissionClaimed,submissionResponse:a.submissionResponse??null,outcome:a.outcome?.kind??'not_signed'})),reservedOrSpentLamports:s.attempts.reduce((n,a)=>n+debit(a),raw(controlledPriorDebit(s))).toString()};
   });
  },
  async resolveExpiry(){
   return d.store.exclusive(async(s,save)=>{
    validateLeaderTestState(s,policy);const a=s.attempts.at(-1);
    if(!d.expiryRpc||!a?.execution||!a.submissionClaimed||a.outcome?.kind==='succeeded'||a.outcome?.kind==='failed')return refused();
    const proof=await verifyControlledExpiry(a.review,a.reviewHash,a.execution,d.expiryRpc);
    a.outcome=proof;await save(s);return proof;
   });
  },
 };
}

// Exercise the exact buy validation path up to signing without a private key,
// persistent store or submission transport. A successful simulation still
// cannot prove that later signing, submission or copied execution will succeed.
export async function reviewControlledLeader(
 d:Omit<Dependencies,'store'|'sign'>&{state:LeaderTestState},
 approval:LeaderTestApproval,policy:ControlledTestPolicy=CONTROLLED_TEST,side:'buy'|'sell'='buy',
){
 let memory=structuredClone(d.state);
 const reachedSigning=Symbol('unsigned review complete');
 const allowed=new Set(['getBlockHeight','getGenesisHash','getSlot','getLatestBlockhash','getFeeForMessage','getAccountInfo','getMultipleAccounts','getEpochInfo','getMinimumBalanceForRentExemption','simulateTransaction']);
 const runner=controlledLeaderTest({...d,
  rpc:async(method,params)=>{if(!allowed.has(method))throw Error('Non-read RPC refused.');return d.rpc(method,params);},
  store:{exclusive:async work=>work(structuredClone(memory),async next=>{memory=structuredClone(next);})},
  sign:async()=>{throw reachedSigning;},
 },policy);
 try{await runner.execute(side,approval);}
 catch(error){if(error===reachedSigning)return {readOnly:true,preSignValidationPassed:true,signed:0,broadcast:0};throw error;}
 throw Error('Unsigned validation did not reach the expected boundary.');
}

export function controlledProposalPolicy(proposal:any):ControlledTestPolicy{
 if(proposal?.version===1&&proposal.venue===undefined)return controlledTestPolicy(proposal.buyLamports);
 if(proposal?.version!==2||(proposal.buyLamports!=='50000'&&!(proposal.venue==='pumpswap'&&proposal.buyLamports==='5000'))||proposal.carryover)throw Error('Unsupported venue test proposal.');
 return controlledTestPolicy(proposal.buyLamports,{mint:proposal.mint,venue:proposal.venue});
}
