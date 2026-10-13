import {createHash} from 'node:crypto';
import {verifyPayoutSignature,type PayoutAttempt} from './launch-payout-model.js';
export type PayoutNonlandingProof={signature:string;packetHash:string;firstSlot:number;lastSlot:number;lastBlockHeight:number;blocksChecked:number;checkedAt:number};
// Only the operator's complete finalized-block audit may supply this proof.
// Null status, elapsed time and an expired blockhash are never sufficient.
export function validatePayoutNonlanding(a:PayoutAttempt,p:PayoutNonlandingProof,now=Date.now()) {
  if(verifyPayoutSignature(a,a.signed,a.payer)!==a.signature||!p||p.signature!==a.signature||
    p.packetHash!==createHash('sha256').update(a.signed).digest('hex')||
    ![p.firstSlot,p.lastSlot,p.lastBlockHeight,p.blocksChecked,p.checkedAt].every(n=>Number.isSafeInteger(n)&&n>0)||
    p.lastSlot<p.firstSlot||p.lastSlot-p.firstSlot>450||p.blocksChecked<2||p.blocksChecked>202||
    p.blocksChecked>p.lastSlot-p.firstSlot+1||p.lastBlockHeight!==a.lastValidBlockHeight+1||
    p.checkedAt>now+30000)throw Error('Complete finalized payout nonlanding proof required.');
}
