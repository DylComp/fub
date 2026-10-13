import {validGiftSelection,type GiftSelection,type GiftOrder} from '../src/gift-checkout-model.js';
import type {PayTransferReview} from '../src/pay-transfer-model.js';
import {invoiceTerms,readCreatedInvoice,readInvoiceStatus} from './bitrefill-invoice.js';
import type {bitrefillCatalog} from './bitrefill-catalog.js';
import {giftRequestHash,type GiftStore,type StoredGift} from './gift-checkout-store.js';
import type {payTransferService} from './pay-transfer-service.js';
import {giftFundingEstimate,giftFundingReadiness} from './gift-funding.js';
import {payRpc} from './pay-rpc.js';
import type {GiftFundingReadiness} from '../src/gift-funding-model.js';
export function publicGift(order:StoredGift):GiftOrder {
 const s=order.secret,i=s.invoice;
 return {id:order.id,product:s.selection.product,name:s.name,value:s.selection.value,currency:s.currency,state:order.state,closed:order.closed,status:s.status?.status||order.state,createdAt:order.createdAt,expiresAt:i?.expiresAt||null,terms:i?invoiceTerms(order.id,i):null,checkedAt:s.status?.checkedAt||null,delivery:s.status?.delivery||null,checkoutUrl:s.status?.checkoutUrl||null};
}
export function giftCheckoutService(store:GiftStore,provider:ReturnType<typeof bitrefillCatalog>,pay:ReturnType<typeof payTransferService>,funding:(wallet:string,amount:string,recipient?:string)=>Promise<GiftFundingReadiness>=(wallet,amount,recipient)=>giftFundingReadiness(wallet,amount,payRpc(),recipient)){
 async function owned(wallet:string,id:string){const o=await store.get(wallet,id);if(!o)throw Error('Purchase not found.');return o;}
 async function refresh(o:StoredGift){if(!o.secret.invoice||!await store.reserveCheck(o.wallet,o.id))return o;
  const i=o.secret.invoice,raw=await provider.invoice(i.id,i.accessToken);return store.status(o,readInvoiceStatus(raw,i,o.secret.selection.product,o.secret.selection.value));
 }
 async function payable(wallet:string,id:string){const o=await refresh(await owned(wallet,id));const i=o.secret.invoice,s=o.secret.status;
  if(o.closed||!i||!s||s.status!=='unpaid'||Date.now()-s.checkedAt>30000||i.expiresAt<Date.now()+90000)throw Error('This invoice cannot accept a new payment. Check purchase status.');return o;
 }
 return {
 async reconcile(wallet:string,id:string){
  const order=await owned(wallet,id),invoice=order.secret.invoice;
  if(order.closed||order.state!=='ready'||!invoice)return {delivery:'skipped',payment:'skipped'};
  // Independent reads: a merchant outage must not prevent recording a finalized
  // USDC payment. Neither branch can prepare, sign, send or recreate an invoice.
  const [delivery,payment]=await Promise.allSettled([
   refresh(order),pay.status(invoiceTerms(id,invoice)),
  ]);
  return {
   delivery:delivery.status==='fulfilled'?
    delivery.value.secret.status?.delivery.refunded?'refunded':
    delivery.value.secret.status?.delivery.status==='delivered'?'delivered':'pending':'unavailable',
   payment:payment.status==='fulfilled'?payment.value.payment?.state||'unpaid':'unavailable',
  };
 },
 async list(wallet:string){return {orders:(await store.list(wallet)).map(publicGift)};},
 async create(wallet:string,id:string,selection:GiftSelection){
  if(!validGiftSelection(selection))throw Error('Check the merchant, amount, region and email.');
  const previous=await store.get(wallet,id);if(previous){if(previous.hash!==giftRequestHash(selection))throw Error('Purchase details changed.');return {order:publicGift(previous)};}
  const detail=await provider.details(selection.product);
  if(!detail.inStock||detail.requiresPrepayment||detail.recipientType!=='none'||detail.country!==selection.country||!detail.paymentMethods.includes('usdc_solana')||!detail.packages.some(p=>p.value===selection.value))throw Error('This product needs checkout on Bitrefill.');
  const selected=detail.packages.find(p=>p.value===selection.value)!;
  // Check funding before the non-idempotent invoice claim. An underfunded
  // wallet can retry this same request ID later without an invoice expiring.
  const readiness=await funding(wallet,giftFundingEstimate(selected.price,selected.priceCurrency));
  if(!readiness.ready)return {funding:readiness};
  const saved=await store.create(wallet,id,giftRequestHash(selection),{selection,name:detail.name,currency:detail.currency});
  if(!saved.created)return {order:publicGift(saved.order)};
  // This provider call is not idempotent. The durable claim is never reclaimed.
  // A timeout locks the purchase for investigation, never creates another invoice.
  try{const started=Date.now(),raw=await provider.createInvoice(selection.product,selection.value,selection.email);const invoice=readCreatedInvoice(raw,selection.product,selection.value,started);const order=await store.ready(saved.order,invoice);return {order:publicGift(order)};}
  catch{await store.uncertain(saved.order);throw Error('Invoice creation is unresolved. Open purchase history before trying again.');}
 },
 async status(wallet:string,id:string){
  const order=await owned(wallet,id),invoice=order.secret.invoice;
  // History remains readable when either provider is unavailable. Omit an
  // unavailable payment result rather than replacing a saved receipt with null.
  const [delivery,payment]=await Promise.allSettled([
   refresh(order),invoice?pay.status(invoiceTerms(id,invoice)):Promise.resolve(null),
  ]);
  return {
   order:publicGift(delivery.status==='fulfilled'?delivery.value:order),
   ...(payment.status==='fulfilled'?{payment:payment.value}:{}),
   checks:{delivery:delivery.status==='fulfilled'?'available' as const:'unavailable' as const,
    payment:payment.status==='fulfilled'?'available' as const:'unavailable' as const},
  };
 },
 async prepare(wallet:string,id:string){
  const o=await payable(wallet,id),i=o.secret.invoice!;
  const recorded=await pay.status(invoiceTerms(id,i));
  if(recorded.payment&&recorded.payment.state!=='failed')return {order:publicGift(o),...recorded};
  const readiness=await funding(wallet,i.rawAmount,i.address);
  if(!readiness.ready)return {order:publicGift(o),funding:readiness};
  return {order:publicGift(o),funding:readiness,...await pay.prepare(wallet,invoiceTerms(id,i))};
 },
 async submit(wallet:string,id:string,review:PayTransferReview,signed:string){
  const o=await owned(wallet,id),i=o.secret.invoice;if(!i||review.sender!==wallet||review.terms?.kind!=='gift-card'||review.terms.id!==id||review.terms.recipient!==i.address||review.terms.rawAmount!==i.rawAmount)throw Error('Payment does not match this invoice.');
  const recorded=await pay.status(invoiceTerms(id,i));
  // Recorded packets may still need reconciliation after expiry, but a new
  // packet is never submitted once the provider has stopped accepting payment.
  if(!recorded.payment||recorded.payment.state==='failed')await payable(wallet,id);
  return {order:publicGift(o),...await pay.submit(review,signed,async()=>{
   const current=await owned(wallet,id);const latest=current.secret.invoice;
   if(current.closed||!latest||latest.expiresAt<Date.now()+30000||latest.address!==i.address||latest.rawAmount!==i.rawAmount)throw Error('This invoice cannot accept a new payment. Check purchase status.');
  })};
 },
 async close(wallet:string,id:string){const o=await refresh(await owned(wallet,id)),i=o.secret.invoice;
  if(!i||i.expiresAt>Date.now()||!o.secret.status||!['unpaid','expired'].includes(o.secret.status.status)||Date.now()-o.secret.status.checkedAt>30000)throw Error('Check the expired invoice before closing it.');
  const result=await pay.status(invoiceTerms(id,i));
  // A finalized failed Solana transaction transfers no USDC. Pending,
  // unresolved and verified payments must retain their invoice recovery path.
  if(result.payment&&result.payment.state!=='failed')throw Error('This purchase has a recorded payment. Resolve it before closing.');await store.close(o);return {closed:true};
 }
 };
}
