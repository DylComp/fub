import {giftOrderId, type GiftOrder} from './gift-checkout-model';
import type {PayTransferReview} from './pay-transfer-model';
import type {GiftFundingReadiness} from './gift-funding-model';

export type GiftPayment = {state:string; signature:string};
export type GiftStatusChecks = {delivery:'available'|'unavailable';payment:'available'|'unavailable'};
export type GiftCheckoutResult = {
 order?:GiftOrder; orders?:GiftOrder[]; review?:PayTransferReview;
 payment?:GiftPayment|{payment:GiftPayment|null; externalReceipt?:unknown}|null;
 externalReceipt?:unknown;
 checks?:GiftStatusChecks;
 funding?:GiftFundingReadiness;
};

// Status wraps the transfer result; submit returns it directly. Both must
// reconcile the same saved packet, including independently found receipts.
export function giftPaymentResult(result:GiftCheckoutResult) {
 const wrapped=result.payment&&'payment' in result.payment?result.payment:null;
 const payment=wrapped?wrapped.payment:result.payment as GiftPayment|null|undefined;
 const externalReceipt=result.externalReceipt||wrapped?.externalReceipt;
 return {payment:payment??null, externalReceipt:!!externalReceipt,
  terminal:!!externalReceipt||payment?.state==='verified'||payment?.state==='failed'};
}

export const shouldRefreshGiftOrder=(order:GiftOrder)=>['ready','creating','uncertain'].includes(order.state)&&!order.closed&&order.status!=='refunded'&&!order.delivery?.refunded&&!(order.status==='complete'&&order.delivery?.status==='delivered');

export function resumableGiftOrder(orders:GiftOrder[],savedId:string|null):GiftOrder|null {
 const unfinished=orders.filter(order=>!order.closed&&
  !(order.status==='complete'&&order.delivery?.status==='delivered')&&
  !order.delivery?.refunded&&order.status!=='refunded');
 // A local ID never authorizes access or proves payment. Resume only an order
 // returned by this wallet's authenticated server history.
 return unfinished.find(order=>giftOrderId(savedId)&&order.id===savedId)||
  [...unfinished].sort((a,b)=>b.createdAt-a.createdAt)[0]||null;
}

export async function loadGiftCheckoutRecovery(
 request:(body:object)=>Promise<GiftCheckoutResult>,savedId:string|null,
 check:()=>void,
):Promise<{orders:GiftOrder[]; result:GiftCheckoutResult|null}> {
 const history=await request({action:'list'});check();
 const orders=history.orders||[],resume=resumableGiftOrder(orders,savedId);
 if(!resume)return {orders,result:null};
 // Refresh this existing invoice, never recreate it or submit a transaction.
 const result=await request({action:'status',id:resume.id});check();
 if(result.order?.id!==resume.id)throw Error('Purchase history could not be verified.');
 return {orders,result};
}
