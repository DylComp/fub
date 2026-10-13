import {confirmedCashDeposit,readCashSpendableDelivery} from './cash-receipt.js';
import {cashRelay} from './cash-relay.js';
import {CASH_NETWORKS,RELAY_SOLANA} from '../src/cash-route.js';
import type {CashPurchase} from './cash-purchase-store.js';
import type {Rpc} from './funding.js';
/** Copies may sell received tokens before economic finality. This does not mark
 * the purchase complete. Its original settlement continues through recovery. */
export async function cashCopyInventory(p:CashPurchase,solana:Rpc,evm:Rpc,fetcher:typeof fetch=fetch){
 if(!p.signed||!p.signature||!['submitted','settling','delayed'].includes(p.state))return null;
 if(await confirmedCashDeposit(p.review,p.signed,solana)!=='confirmed')return null;
 const status=await cashRelay(fetcher).status(p.review.quote.requestId) as any,q=p.review.quote;
 if(!['submitted','success'].includes(status?.status))return null;
 if(status.originChainId!==RELAY_SOLANA||status.destinationChainId!==CASH_NETWORKS[q.network].chainId||!Array.isArray(status.inTxHashes)||status.inTxHashes.length!==1||status.inTxHashes[0]!==p.signature||!Array.isArray(status.txHashes)||status.txHashes.length!==1||status.failReason&&status.failReason!=='N/A')throw Error('Copy inventory association differs.');
 return readCashSpendableDelivery(q,status.txHashes[0],evm);
}
