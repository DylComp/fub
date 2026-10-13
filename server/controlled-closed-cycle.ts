import {dirname,join} from 'node:path';
import {readPrivateTestFile} from './controlled-leader-files.js';
import {controlledStateHash} from './controlled-carryover.js';
import {validateLeaderTestState,type LeaderTestState,type ClosedTestCycle,type ControlledTestPolicy} from './controlled-leader-test.js';
import {controlledWindowProposal} from './controlled-window-selection.js';
import {verifyControlledRebalance} from './controlled-leader-funding.js';
import {recoverRaydium22Execution} from './native-copy-review.js';
import type {Rpc} from './funding.js';

export function verifyClosedCycleBudget(parent:LeaderTestState,current:LeaderTestState,policy:ControlledTestPolicy,transfer:ReturnType<typeof verifyControlledRebalance>){
 validateLeaderTestState(parent,policy);validateLeaderTestState(current,policy);
 const c=current.closedCycle;
 if(!c||parent.carryover||parent.leader!==current.leader||controlledStateHash(parent)!==c.parentStateHash||parent.attempts.length!==2)throw Error('Closed parent changed.');
 // A second generation must use a genuinely new follower plan. Its prior
 // successful executions are never put on the unsigned-expiry allowlist.
 if(parent.closedCycle){
  if(!c.previousPlanId||parent.closedCycle.previousPlanId||c.previousPlanId!==parent.closedCycle.planId||c.priorAttempts.length)throw Error('Fresh follower plan required.');
 }else if(c.previousPlanId)throw Error('Unexpected plan replacement.');
 const [buy,sell]=parent.attempts;
 if(buy.side!=='buy'||sell.side!=='sell'||[buy,sell].some(a=>!a.execution||!a.submissionClaimed||a.outcome?.kind!=='succeeded')||buy.outcome?.kind!=='succeeded'||sell.outcome?.kind!=='succeeded'||buy.outcome.outputRaw!==sell.outcome.inputRaw)throw Error('Parent inventory is not fully sold.');
 let spent=parent.attempts.reduce((n,a)=>{if(a.outcome?.kind!=='succeeded')throw Error();return n+BigInt(a.outcome.feeLamports)+BigInt(a.outcome.rentLamports)+(a.side==='buy'?BigInt(a.outcome.inputRaw):0n);},0n);
 let credit=0n;
 if(parent.closedCycle){
  spent+=BigInt(parent.closedCycle.spentLamports);
  credit=BigInt(parent.closedCycle.balanceCreditLamports);
 }else if(transfer.sender===parent.leader)spent+=BigInt(transfer.totalDebitLamports);
 else if(transfer.recipient===parent.leader)credit=BigInt(transfer.amountLamports);
 else throw Error('Rebalance does not belong to this test wallet.');
 if(transfer.amountLamports!=='100000'||BigInt(transfer.feeLamports)>10000n||spent.toString()!==c.spentLamports||credit.toString()!==c.balanceCreditLamports)throw Error('Prior spending changed.');
 return {spentLamports:spent.toString(),balanceCreditLamports:credit.toString()};
}
// A single separately approved child of a fully sold cycle. No old job, grant,
// attempt or private key is reset/copied. Both sides retain the original caps.
export async function readControlledClosedCycle(directory:string,state:LeaderTestState,run:string|undefined,policy:ControlledTestPolicy,rpc?:Rpc):Promise<{directory:string;planId:string;priorAttempts:ClosedTestCycle['priorAttempts'];spentLamports:string;balanceCreditLamports:string}|null>{
 if(!state.closedCycle)return null;
 validateLeaderTestState(state,policy);
 const c=state.closedCycle,parentDir=join(dirname(directory),c.parentRun);
 if(!run||c.parentRun===run)throw Error('Invalid closed-cycle selection.');
 const claim=await readPrivateTestFile(join(parentDir,'closed-cycle-child.json'));
 if(claim.run!==run||claim.parentStateHash!==c.parentStateHash)throw Error('Closed cycle already assigned.');
 const oldWindow=await readPrivateTestFile(join(parentDir,'window-claim.json'));
 if(oldWindow.planId!==(c.previousPlanId??c.planId))throw Error('Closed plan changed.');
 const parent=await readPrivateTestFile(join(parentDir,'state.json')) as LeaderTestState;
 const previous=controlledWindowProposal(await readPrivateTestFile(join(parentDir,'proposal.json')),parent);
 if(JSON.stringify(previous.policy)!==JSON.stringify(policy))throw Error('Closed cycle scope changed.');
 // The one-child claims and hashes are checked at every generation. Resolve
 // the original wallet location without copying its private key.
 if(parent.closedCycle&&(parent.closedCycle.previousPlanId||!c.previousPlanId))throw Error('Unsupported cycle depth.');
 const ancestor=parent.closedCycle?await readControlledClosedCycle(parentDir,parent,c.parentRun,policy,rpc):null;
 const walletDirectory=ancestor?.directory??parentDir;
 const rebalance=await readPrivateTestFile(join(walletDirectory,'rebalance.json'));
 const expected={follower:'433x1KGCMPBwkpv9ru2gtatC2MqxMF4Ugk2oTVmQUREu',leader:'G1uCkCxpxnhMqMFZa1wCD35Lq1RiBTnoNJJHfKxbLmx6',signature:rebalance.signature};
 const receipt=rpc?await rpc('getTransaction',[expected.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]):rebalance.receipt;
 const transfer=verifyControlledRebalance(receipt,expected);
 verifyClosedCycleBudget(parent,state,policy,transfer);
 if(rpc)for(const a of parent.attempts){
  const actual=await recoverRaydium22Execution(a.review,a.reviewHash,a.execution!,rpc);
  if(actual.kind!=='succeeded'||a.outcome?.kind!=='succeeded'||actual.inputRaw!==a.outcome.inputRaw||actual.outputRaw!==a.outcome.outputRaw||actual.feeLamports!==a.outcome.feeLamports||actual.rentLamports!==a.outcome.rentLamports)throw Error('Closed-cycle receipt changed.');
 }
 return {directory:walletDirectory,planId:c.planId,priorAttempts:c.priorAttempts,...verifyClosedCycleBudget(parent,state,policy,transfer)};
}
