import {inspectCashLimitPurchase,inspectCashLimitSale,cashLimitSaleGas} from './cash-limit-review.js';
import {simulateCashDeposit} from './cash-deposit.js';
import type {CashLimitTerms} from '../src/cash-limit-model.js';
import type {CashPurchase} from './cash-purchase-store.js';
import type {CashSale} from './cash-return-store.js';
import type {Rpc} from './funding.js';
// Refresh only evidence from an actual simulation of the immutable transaction.
// Original provider deadline, output guarantee and permission never extend.
export async function inspectCashLimitPurchaseDelivery(t:CashLimitTerms,p:CashPurchase,rpc:Rpc,now=Date.now,simulate=simulateCashDeposit){
 const started=now();if(p.review.quote.expiresAt<=started)throw Error('Signed purchase quote expired.');
 await simulate(p.review,rpc,p.signed||undefined,started);
 inspectCashLimitPurchase(t,{...p.review.quote,checkedAt:started},now());
}
export async function inspectCashLimitSaleDelivery(t:CashLimitTerms,p:CashSale,c:{balances:()=>Promise<{tokenRaw:string;gasRaw:string}>;partial:()=>Promise<boolean>;inspect:()=>Promise<CashSale>;now?:()=>number}){
 const now=c.now||Date.now,started=now(),expiresAt=Math.min(p.simulation.expiresAt,p.gas.expiresAt);
 if(expiresAt<=started)throw Error('Signed sale quote expired.');
 const checked=await c.partial()?p:await c.inspect();
 const balances=await c.balances(),route=p.simulation.route;
 const l1=BigInt(checked.gas.maxL1FeeWei)>BigInt(p.gas.maxL1FeeWei)?checked.gas.maxL1FeeWei:p.gas.maxL1FeeWei;
 inspectCashLimitSale(t,{...route.intent,minimumUsdcRaw:route.minimumRaw,maximumGasRaw:cashLimitSaleGas({...p.gas,maxL1FeeWei:l1}),checkedAt:started,expiresAt},balances.tokenRaw,balances.gasRaw,now());
}
