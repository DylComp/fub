import type {GiftOrder} from './gift-checkout-model';
import {isMint} from './assets';
import {payAmount} from './pay-model';
export type PurchaseSplitDraft={wallet:string;title:string;amount:string;createdAt:number};
export const PURCHASE_SPLIT_KEY='fub.pay.purchase-split.v1';
// Share only the merchant and cost. Codes, receipt URLs and invoice addresses
// never leave the authenticated gift receipt through a reimbursement link.
export function purchaseSplitDraft(order:GiftOrder,wallet:string,now=Date.now()):PurchaseSplitDraft|null{
 if(!isMint(wallet)||order.status!=='complete'||order.delivery?.status!=='delivered'||order.delivery.refunded||!order.terms)return null;
 const raw=order.terms.rawAmount;
 if(!/^[1-9]\d{0,14}$/.test(raw)||BigInt(raw)%10000n!==0n)return null;
 const cents=Number(BigInt(raw)/10000n);
 if(cents<2||cents>100000000)return null;
 return{wallet,title:order.name.slice(0,80),amount:payAmount(cents),createdAt:now};
}
export function readPurchaseSplit(raw:string|null,wallet:string|undefined,now=Date.now()):PurchaseSplitDraft|null{
 try{if(!raw||raw.length>1000||!wallet)return null;const d=JSON.parse(raw) as PurchaseSplitDraft;
 if(Object.keys(d).sort().join(',')!=='amount,createdAt,title,wallet'||d.wallet!==wallet||!isMint(wallet)||typeof d.title!=='string'||!d.title.trim()||d.title.length>80||typeof d.amount!=='string'||!/^\d{1,7}\.\d{2}$/.test(d.amount)||!Number.isSafeInteger(d.createdAt)||d.createdAt>now||now-d.createdAt>600000)return null;
 return d;
 }catch{return null;}
}
