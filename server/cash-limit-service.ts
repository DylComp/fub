import {cashLimitEngine,type CashLimitJournal} from './cash-limit-engine.js';
import {inspectCashLimitPurchase,inspectCashLimitSale,cashLimitSaleGas} from './cash-limit-review.js';
import {limitRaw,cashLimitReached,type CashLimitTerms,type CashLimitObservation} from '../src/cash-limit-model.js';
import type {cashPurchaseService} from './cash-purchase-service.js';
import type {cashReturnService} from './cash-return-service.js';
import type {CashPurchase,CashPurchaseStore} from './cash-purchase-store.js';
import type {CashSale,CashReturnStore} from './cash-return-store.js';
export type CashLimitExecutionReview={side:'buy';purchase:CashPurchase}|{side:'sell';sale:CashSale};
export function cashLimitService(c:{journal:CashLimitJournal<CashLimitExecutionReview>;purchases:ReturnType<typeof cashPurchaseService>;returns:ReturnType<typeof cashReturnService>;
 purchaseStore:CashPurchaseStore;saleStore:CashReturnStore;deliveryOnly?:boolean;enabled:()=>boolean;authorized:(terms:CashLimitTerms)=>Promise<boolean>;
 price:(terms:CashLimitTerms)=>Promise<CashLimitObservation>;
 balances:(terms:CashLimitTerms)=>Promise<{tokenRaw:string;gasRaw:string}>;
 signer:{sign:(id:string)=>Promise<string[]>;recover:(id:string)=>Promise<string[]|null>};now?:()=>number;
}){
 const now=c.now||Date.now;
 return cashLimitEngine<CashLimitExecutionReview>({journal:c.journal,enabled:c.enabled,authorized:c.authorized,price:c.price,now,
  prepare:async t=>t.side==='buy'?{side:'buy',purchase:await c.purchases.prepare(t.id,{sourceWallet:t.sourceWallet,recipient:t.recipient,network:t.network,token:t.token,amountRaw:t.amountRaw,slippageBps:t.slippageBps,gasTopupUsdcRaw:t.gasTopupUsdcRaw})}:{side:'sell',sale:await c.returns.prepare(t.id,{network:t.network,wallet:t.recipient,cashWallet:t.sourceWallet,token:t.token,amountRaw:t.amountRaw,slippageBps:t.slippageBps},t.maxSaleGasRaw)},
  inspect:async(t,r)=>{
   if(t.side!==r.side)throw Error('Limit execution side changed.');
   if(r.side==='buy'){
    const p=r.purchase;
    inspectCashLimitPurchase(t,p.review.quote,now());
    if(p.id!==t.id||p.wallet!==t.sourceWallet||p.review.intent.slippageBps!==t.slippageBps||limitRaw(p.review.maxFeeLamports)+limitRaw(p.review.maxRentLamports)>limitRaw(t.maxSourceFeeLamports))throw Error('Limit deposit budget changed.');
   }else{
    const p=r.sale,route=p.simulation.route,b=await c.balances(t);
    if(p.id!==t.id||p.wallet!==t.sourceWallet||route.intent.slippageBps!==t.slippageBps)throw Error('Limit sale identity changed.');
    inspectCashLimitSale(t,{...route.intent,minimumUsdcRaw:route.minimumRaw,maximumGasRaw:cashLimitSaleGas(p.gas),checkedAt:Math.min(p.simulation.checkedAt,p.gas.checkedAt),expiresAt:Math.min(p.simulation.expiresAt,p.gas.expiresAt)},b.tokenRaw,b.gasRaw,now());
   }
  },
  sign:async t=>c.signer.sign(t.id),
  submit:async(t,r,bytes)=>{
   if(r.side==='buy'){
    if(bytes.length!==1)throw Error('One deposit signature required.');
    if(c.deliveryOnly)await c.purchaseStore.bind(t.id,t.sourceWallet,bytes[0]);
    else await c.purchases.submit(t.id,t.sourceWallet,bytes[0]);
   }else if(c.deliveryOnly)await c.saleStore.bind(t.id,t.sourceWallet,bytes);
   else await c.returns.submit(t.id,t.sourceWallet,bytes);
  },
  recover:async job=>{
   const t=job.terms;
   // Recover exact bytes from the independent signer journal after a crash.
   // Binding is persistence only; these store methods validate the signatures
   // and cannot broadcast or renew an expired permission.
   const bytes=job.signed||await c.signer.recover(t.id);
   if(bytes&&!job.signed){
    // Restore the outer delivery journal as well as the transaction store.
    // Re-read next tick because this CAS advances its revision.
    await c.journal.signed(job,bytes);return 'pending';
   }
   if(bytes){
    if(t.side==='buy'){
     if(bytes.length!==1)throw Error('Invalid saved limit deposit.');
     const saved=await c.purchaseStore.get(t.id,t.sourceWallet);
     if(!saved)throw Error('Limit deposit journal missing.');
     if(!saved.signed)await c.purchaseStore.bind(t.id,t.sourceWallet,bytes[0]);
     else if(saved.signed!==bytes[0])throw Error('Limit deposit signature changed.');
    }else{
     const saved=await c.saleStore.get(t.id,t.sourceWallet);
     if(!saved)throw Error('Limit sale journal missing.');
     if(!saved.signed)await c.saleStore.bind(t.id,t.sourceWallet,bytes);
     else if(JSON.stringify(saved.signed)!==JSON.stringify(bytes))throw Error('Limit sale signatures changed.');
    }
   }
   let result=t.side==='buy'?await c.purchases.status(t.id,t.sourceWallet):await c.returns.status(t.id,t.sourceWallet);
   if(!c.deliveryOnly&&bytes&&result&&['submitted','settling','delayed'].includes(result.state)&&c.enabled()&&now()<t.expiresAt&&await c.authorized(t)){
    // Retransmit only the already saved transaction, within the original
    // signed permission and current trigger. Never refresh a signed quote.
    if(cashLimitReached(t,await c.price(t),now()))result=t.side==='buy'?await c.purchases.resume(t.id,t.sourceWallet):await c.returns.resume(t.id,t.sourceWallet);
   }
   // Never label a refunded/reverted swap as a filled order.
   return result?.state==='complete'?'complete':'pending';
  },
 });
}
