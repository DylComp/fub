import { USDC } from '../src/funding-model.js';
import { isMint } from '../src/assets.js';
import { giftOrderId } from '../src/gift-checkout-model.js';
const object = (v:unknown):Record<string,unknown> => v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
export type Invoice = { id:string; accessToken:string; address:string; rawAmount:string; expiresAt:number; createdAt:number };
export type InvoiceStatus = { status:string; checkedAt:number; checkoutUrl:string|null; delivery:{status:string;link:string|null;refunded:boolean;code?:string|null} };
// Only HTTPS provider links. Redemption credentials remain behind owner auth.
export function privateBitrefillLink(v:unknown):string|null {
 if(v===undefined||v===null)return null;
 if(typeof v!=='string'||v.length>4096)throw Error('Invalid receipt link.');
 const u=new URL(v);if(u.origin!=='https://www.bitrefill.com'||u.username||u.password)throw Error('Invalid receipt link.');return u.href;
}
function usdcRaw(value:unknown){
 if(typeof value!=='string'||!/^(0|[1-9]\d{0,3})(\.\d{1,6})?$/.test(value))throw Error('Unsupported invoice payment.');
 const [whole,fraction='']=value.split('.'),raw=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));
 if(raw<=0n||raw>1000000000n)throw Error('Invoice amount mismatch.');return String(raw);
}
function payment(value:unknown){
 const p=object(value);if(!isMint(p.address as string)||p.contractAddress!==USDC||typeof p.altcoinPrice!=='string'||!/^(0|[1-9]\d{0,3})(\.\d{1,6})?$/.test(p.altcoinPrice)||!Number.isSafeInteger(p.altBasePrice))throw Error('Unsupported invoice payment.');
 const rawAmount=usdcRaw(p.altcoinPrice);if(BigInt(rawAmount)!==BigInt(p.altBasePrice as number))throw Error('Invoice amount mismatch.');
 return {address:p.address as string,rawAmount};
}
function detectedPayment(value:unknown){
 const p=object(value);
 if(p.method!=='usdc_solana'||p.currency!=='USDC'||!isMint(p.address as string)||p.partial_payment!==false||!Array.isArray(p.incoming_tx_ids)||p.incoming_tx_ids.length===0||!p.incoming_tx_ids.every(s=>typeof s==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s)))throw Error('Unsupported detected payment.');
 return {address:p.address as string,rawAmount:usdcRaw(p.price)};
}
export function readCreatedInvoice(raw:Record<string,unknown>,product:string,value:string,startedAt:number):Invoice{
 const r=object(raw.response),items=r.cart_items,createdAt=typeof r.created_time==='string'?Date.parse(r.created_time):NaN;
 if(!uuid(r.invoice_id)||typeof r.invoice_access_token!=='string'||r.invoice_access_token.length<8||r.invoice_access_token.length>2000||!Array.isArray(items)||items.length!==1||object(items[0]).id!==product||String(object(items[0]).value)!==value||!Number.isFinite(createdAt)||Math.abs(createdAt-startedAt)>120000||!Number.isInteger(r.expiration_minutes)||Number(r.expiration_minutes)<1||Number(r.expiration_minutes)>120)throw Error('Invalid purchase invoice.');
 // Conservative price lock. The UI will not prepare a payment near expiry.
 return {id:r.invoice_id,accessToken:r.invoice_access_token,...payment(r.payment_info),createdAt,expiresAt:createdAt+Number(r.expiration_minutes)*60000};
}
export function readInvoiceStatus(raw:Record<string,unknown>,invoice:Invoice,product:string,value:string):InvoiceStatus{
 if(raw.invoice_id!==invoice.id||!Array.isArray(raw.orders)||raw.orders.length!==1||typeof raw.invoice_status!=='string'||!['unpaid','payment_detected','payment_confirmed','complete','blocked','expired','refunded','invalid','underpaid','overpaid'].includes(raw.invoice_status))throw Error('Invalid invoice status.');
 // Paid invoices replace payment_info with detected_payment_info. Bind either
 // response to the original invoice rather than treating missing fields as paid.
 const detected=raw.detected_payment_info===undefined?null:detectedPayment(raw.detected_payment_info);
 const p=raw.payment_info!==undefined?payment(raw.payment_info):['payment_detected','payment_confirmed','complete','blocked','refunded'].includes(raw.invoice_status)?detected:null;
 if(!p||detected&&(detected.address!==invoice.address||detected.rawAmount!==invoice.rawAmount))throw Error('Invoice payment identity changed.');
 const order=object(raw.orders[0]),item=object(order.product);
 if(p.address!==invoice.address||p.rawAmount!==invoice.rawAmount||order.invoice_id!==invoice.id||item.id!==product||String(item.value)!==value||order.payment_method!=='usdc_solana'||typeof order.status!=='string'||order.status.length>40||typeof order.refunded!=='boolean')throw Error('Invoice identity changed.');
 const delivered=order.status==='delivered'&&order.refunded===false;
 const pin=object(order.redemption_info).pin;
 const code=delivered&&order.redemption_available===true&&typeof pin==='string'&&pin.trim().length>0&&pin.length<=512&&!/[\u0000-\u001f\u007f]/.test(pin)?pin:null;
 return {status:raw.invoice_status,checkedAt:Date.now(),checkoutUrl:privateBitrefillLink(raw.checkout_url),delivery:{status:order.status,refunded:order.refunded,link:delivered?privateBitrefillLink(order.access_link):null,code}};
}
export function invoiceTerms(orderId:string,invoice:Invoice){if(!giftOrderId(orderId))throw Error('Invalid order.');return {id:orderId,kind:'gift-card' as const,recipient:invoice.address,rawAmount:invoice.rawAmount};}
