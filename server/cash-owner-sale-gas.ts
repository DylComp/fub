import type {CashCopyDocument} from './cash-copy-journal.js';
import type {CashCopyJob} from './cash-copy-service.js';
import type {Rpc} from './funding.js';
/** Exact transaction state delta, not an entire block's unrelated deposits.
 * Ambiguous lots or unresolved fee history cannot fund an owner recovery. */
export async function cashOwnerSaleGas(d:CashCopyDocument,j:CashCopyJob,rpc:Rpc){
 const buys=Object.values(d.jobs).filter(b=>b.event.side==='buy'&&b.event.network===j.event.network&&b.scope.id===j.scope.id&&b.state!=='stopped');
 if(buys.length!==1)throw Error('Recovery gas allocation is ambiguous.');
 const b=buys[0],p=b.purchase,r=p?.receipt,q=p?.review.quote;
 if(b.state!=='complete'||b.leaderInvalidatedAt||!r?.finalized||!r.successful||r.recipient.toLowerCase()!==j.scope.recipient||q?.recipient!==j.scope.recipient||!q.gasTopup||b.event.token!==j.event.token)throw Error('Finalized recovery gas funding is missing.');
 const receipt:any=await rpc('eth_getTransactionReceipt',[r.transaction]);
 const [block,final,trace]:any[]=await Promise.all([rpc('eth_getBlockByNumber',[receipt?.blockNumber,false]),rpc('eth_getBlockByNumber',['finalized',false]),rpc('debug_traceTransaction',[r.transaction,{tracer:'prestateTracer',tracerConfig:{diffMode:true}}])]);
 if(receipt?.status!=='0x1'||receipt.transactionHash?.toLowerCase()!==r.transaction.toLowerCase()||block?.hash!==receipt.blockHash||BigInt(final.number)<BigInt(receipt.blockNumber))throw Error('Recovery gas receipt is not finalized.');
 const pre=trace?.pre?.[j.scope.recipient],post=trace?.post?.[j.scope.recipient];
 if(!pre||!post||typeof pre.balance!=='string'||typeof post.balance!=='string'||post.nonce!==undefined&&post.nonce!==pre.nonce)throw Error('Recovery gas delivery is ambiguous.');
 if(!Number.isSafeInteger(pre.nonce)||pre.nonce<0)throw Error('Recovery gas nonce evidence missing.');
 let consumedNonces=0n;let available=BigInt(post.balance)-BigInt(pre.balance);const allocation=BigInt(q.gasTopup.promisedWei);if(available>allocation)available=allocation;
 for(const s of Object.values(d.jobs).filter(s=>s.id!==j.id&&s.event.side==='sell'&&s.event.network===j.event.network&&s.event.blockTime>=b.event.blockTime)){
  if(s.state==='stopped'&&!s.signed&&!s.sale?.signed)continue;
  if(s.state!=='complete'||!s.sale?.feeWei||!/^\d+$/.test(s.sale.feeWei))throw Error('Recovery gas consumption is unresolved.');available-=BigInt(s.sale.feeWei);
  if(!s.sale.signed?.length)throw Error('Recovery gas fee history is incomplete.');consumedNonces+=BigInt(s.sale.signed.length);
 }
 const pending=await rpc('eth_getTransactionCount',[j.scope.recipient,'pending']);
 if(typeof pending!=='string'||!/^0x[0-9a-f]+$/i.test(pending)||BigInt(pending)!==BigInt(pre.nonce)+consumedNonces)throw Error('Recovery gas has other wallet activity.');
 if(available<=0n)throw Error('No purchased gas remains.');return available;
}
