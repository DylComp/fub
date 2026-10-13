import {createHash} from 'node:crypto';
import {verifyBuybackSigned,type BuybackAttempt} from './buyback-model.js';
export type BuybackNonlandingProof={signature:string;packetHash:string;firstSlot:number;lastSlot:number;lastBlockHeight:number;blocksChecked:number;checkedAt:number};
// Operator-only finalized block-chain audit. Null status or expiry alone never
// releases funds. Retaining this proof does not authorize another purchase.
export function validateBuybackNonlanding(a:BuybackAttempt,p:BuybackNonlandingProof,now=Date.now()){
 if(verifyBuybackSigned(a.plan,a.signed)!==a.signature||!p||p.signature!==a.signature||
 p.packetHash!==createHash('sha256').update(a.signed).digest('hex')||
 ![p.firstSlot,p.lastSlot,p.lastBlockHeight,p.blocksChecked,p.checkedAt].every(n=>Number.isSafeInteger(n)&&n>0)||
 p.firstSlot<a.plan.contextSlot||p.lastSlot<p.firstSlot||p.lastSlot-p.firstSlot>450||p.blocksChecked<2||p.blocksChecked>202||
 p.blocksChecked>p.lastSlot-p.firstSlot+1||p.lastBlockHeight!==a.plan.lastValidBlockHeight+1||
 p.checkedAt<a.plan.preparedAt||p.checkedAt>now+30000)throw Error('Complete finalized buyback nonlanding proof required.');
}
