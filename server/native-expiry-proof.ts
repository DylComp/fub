import { signatureValid } from './copy-classifier.js';
import type { ControlledExpiry } from './controlled-leader-expiry.js';
import type { Raydium22ExecutionReview } from './native-copy-review.js';
export type SignedNativeExpiry = {status:'signed-expired';wallet:string;executionId:string;claimId:string;reviewHash:string;signature:string;proof:ControlledExpiry};
type Identity = Pick<SignedNativeExpiry,'wallet'|'executionId'|'claimId'|'reviewHash'>;
// This validates an authenticated private-service result, not caller-submitted
// proof. The private service itself must scan the finalized chain before saving.
export function validateSignedNativeExpiry(v:SignedNativeExpiry,r:Identity,review?:Raydium22ExecutionReview,signature?:string){
 const fail=():never=>{throw Error('Signed expiry evidence changed.');};
 if(!v||Object.keys(v).sort().join(',')!=='claimId,executionId,proof,reviewHash,signature,status,wallet'||v.status!=='signed-expired'||
 v.wallet!==r.wallet||v.executionId!==r.executionId||v.claimId!==r.claimId||v.reviewHash!==r.reviewHash||!signatureValid(v.signature)||signature&&signature!==v.signature)return fail();
 const p=v.proof;
 if(!p||Object.keys(p).sort().join(',')!=='blocksChecked,checkedAt,firstSlot,kind,lastBlockHeight,lastSlot,signature'||p.kind!=='expired'||p.signature!==v.signature||
 [p.firstSlot,p.lastSlot,p.lastBlockHeight,p.blocksChecked,p.checkedAt].some(n=>!Number.isSafeInteger(n)||n<1)||
 p.lastSlot<p.firstSlot||p.lastSlot-p.firstSlot>800||p.blocksChecked<2||p.blocksChecked>801||p.blocksChecked>p.lastSlot-p.firstSlot+1||p.checkedAt>Date.now()+5000)return fail();
 if(review&&(p.lastSlot<review.minContextSlot||p.firstSlot>review.minContextSlot||p.firstSlot<review.minContextSlot-400||p.lastSlot>review.minContextSlot+400||p.lastBlockHeight!==review.lastValidBlockHeight+1||p.checkedAt<review.reviewedAt))return fail();
 return v;
}
