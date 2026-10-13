import {randomUUID} from 'node:crypto';
import {neon} from '@neondatabase/serverless';
import {isCashNetwork,cashAmountRaw,type CashNetwork} from '../src/cash-route.js';
import {isEvmAddress} from '../src/networks.js';
import type {cashTradeRuntime} from './cash-trade-api.js';
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
import {cashPublicSaleId} from './cash-public-id.js';
export {cashPublicSaleId} from './cash-public-id.js';
export const CASH_PUBLIC_BUDGETS={
 base:{gasTopupUsdcRaw:'100000',maxGasRaw:'100000000000000'},
 bnb:{gasTopupUsdcRaw:'100000',maxGasRaw:'100000000000000'},
 monad:{gasTopupUsdcRaw:'100000',maxGasRaw:'350000000000000000'},
 robinhood:{gasTopupUsdcRaw:'100000',maxGasRaw:'30000000000000'},
 arc:{gasTopupUsdcRaw:'100000',maxGasRaw:'50000000000000000'},
 ethereum:{gasTopupUsdcRaw:'300000',maxGasRaw:'100000000000000'},
} as const;
export function publicCashNetworks():CashNetwork[]{
 const value=process.env.CASH_PUBLIC_NETWORKS||'';if(!value)return[];
 const networks=value.split(',');if(networks.some(n=>!isCashNetwork(n))||new Set(networks).size!==networks.length)throw Error('Invalid public cash networks.');return networks as CashNetwork[];
}
export function cashPublicHistory(url:string){return async(wallet:string,network:CashNetwork,token:string)=>{
 const sql=neon(url,{fetchOptions:{signal:AbortSignal.timeout(8000)}});
 const rows=await sql`SELECT p.id FROM fub_cash_purchases p LEFT JOIN fub_cash_sales s ON s.id::text=p.review->>'publicSaleId' AND s.wallet=p.wallet
 WHERE p.wallet=${wallet} AND p.review->>'admission'='public-v1' AND p.review->'intent'->>'network'=${network} AND p.review->'intent'->>'token'=${token}
 AND p.state NOT IN ('refunded','reverted') AND (s.state IS NULL OR s.state<>'complete') ORDER BY p.created_at ASC LIMIT 25`;
 return rows.map(r=>String(r.id));
};}
type Runtime=ReturnType<typeof cashTradeRuntime>;
export async function handlePublicCash(body:Record<string,unknown>,wallet:string,network:CashNetwork,runtime:Runtime,history:ReturnType<typeof cashPublicHistory>){
 const send=(status:number,data:unknown)=>({status,data}),keys=Object.keys(body).sort().join(','),b=body as any;
 if(!publicCashNetworks().includes(network)||!runtime.enabled(network))return send(409,{message:'Trading is unavailable on this network. Existing trades remain recoverable.'});
 const budgets=CASH_PUBLIC_BUDGETS[network];
 if(b.action==='public-state'&&keys==='action,network,token'&&typeof b.token==='string'&&isEvmAddress(b.token)){
  for(const id of await history(wallet,network,b.token.toLowerCase())){
   const p=await runtime.purchases.status(id,wallet);if(!p||p.review.admission!=='public-v1')continue;
   if(p.review.intent.network!==network||p.review.intent.token!==b.token.toLowerCase())throw Error('Purchase history changed.');
   const saleId=cashPublicSaleId(id),s=await runtime.returns.status(saleId,wallet);
   if(['refunded','reverted'].includes(p.state)||s&&s.state==='complete')continue;
   return send(200,{purchaseId:id,saleId,purchase:p,sale:s});
  }
  const purchaseId=randomUUID();return send(200,{purchaseId,saleId:cashPublicSaleId(purchaseId),purchase:null,sale:null});
 }
 const binding=await runtime.bindings.binding(wallet,network);
 if(!binding||binding.sourceWallet!==wallet||binding.network!==network||binding.accountType!=='eoa'||binding.expiresAt<=Date.now()||binding.verifiedAt>Date.now())return send(409,{message:'Verify your cross-chain wallet before trading.'});
 if(b.action==='public-purchase-prepare'&&keys==='action,amount,id,network,token'&&uuid(b.id)&&typeof b.token==='string'&&isEvmAddress(b.token)&&typeof b.amount==='string'){
  const amountRaw=cashAmountRaw(b.amount);
  return send(200,await runtime.purchases.prepare(b.id,{sourceWallet:wallet,recipient:binding.recipient,network,token:b.token.toLowerCase(),amountRaw,slippageBps:100,gasTopupUsdcRaw:budgets.gasTopupUsdcRaw},'public-v1'));
 }
 if(['public-purchase-submit','public-purchase-resume'].includes(b.action)&&uuid(b.id)&&keys===(b.action.endsWith('submit')?'action,id,network,signed':'action,id,network')){
  const p=await runtime.purchases.status(b.id,wallet);
  if(!p||p.review.admission!=='public-v1'||p.review.intent.network!==network||p.review.intent.recipient!==binding.recipient)return send(404,{message:'Purchase not found for this wallet and network.'});
  if(b.action.endsWith('submit')&&typeof b.signed!=='string')return send(400,{message:'Invalid purchase signature.'});
  return send(200,await(b.action.endsWith('submit')?runtime.purchases.submit(b.id,wallet,b.signed):runtime.purchases.resume(b.id,wallet)));
 }
 if(['public-sale-prepare','public-sale-submit','public-sale-resume'].includes(b.action)&&uuid(b.purchaseId)&&uuid(b.id)&&b.id===cashPublicSaleId(b.purchaseId)&&keys===(b.action.endsWith('submit')?'action,id,network,purchaseId,signed':'action,id,network,purchaseId')){
  const p=await runtime.purchases.status(b.purchaseId,wallet);
  if(!p||p.review.admission!=='public-v1'||p.state!=='complete'||!p.receipt||p.review.intent.network!==network||p.review.intent.recipient!==binding.recipient)return send(409,{message:'Wait for verified token delivery to this wallet.'});
  if(b.action.endsWith('prepare'))return send(200,await runtime.returns.prepare(b.id,{network,wallet:binding.recipient,cashWallet:wallet,token:p.review.intent.token,amountRaw:p.receipt.receivedRaw,slippageBps:100},budgets.maxGasRaw));
  const s=await runtime.returns.status(b.id,wallet);
  if(!s||s.simulation.route.intent.network!==network||s.simulation.route.intent.token!==p.review.intent.token||s.simulation.route.intent.amountRaw!==p.receipt.receivedRaw||s.simulation.route.intent.wallet!==binding.recipient)return send(404,{message:'Sale not found for this position.'});
  if(b.action.endsWith('submit')&&(!Array.isArray(b.signed)||!b.signed.every((v:unknown)=>typeof v==='string')))return send(400,{message:'Invalid sale signatures.'});
  return send(200,await(b.action.endsWith('submit')?runtime.returns.submit(b.id,wallet,b.signed):runtime.returns.resume(b.id,wallet)));
 }
 return send(400,{message:'Invalid trade fields.'});
}
