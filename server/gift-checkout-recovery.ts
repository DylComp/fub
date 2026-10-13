import {neon} from '@neondatabase/serverless';
import {giftCheckoutStore} from './gift-checkout-store.js';
import {giftCheckoutService} from './gift-checkout-service.js';
import {bitrefillCatalog} from './bitrefill-catalog.js';
import {payTransferStore} from './pay-transfer-store.js';
import {payTransferService} from './pay-transfer-service.js';
import {payRpc} from './pay-rpc.js';
import {rpcRequest,type Rpc} from './funding.js';

type Candidate={id:string;wallet:string};
type Outcome={delivery:string;payment:string};
type Dependencies={
 candidates:(limit:number)=>Promise<Candidate[]>;
 reconcile:(wallet:string,id:string)=>Promise<Outcome>;
 now?:()=>number;
};
const readMethods=new Set(['getGenesisHash','getTransaction','getSignatureStatuses','getBlockHeight','getSignaturesForAddress','getAccountInfo','getMultipleAccounts']);
export function giftRecoveryRpc(rpc:Rpc):Rpc {
 return (method,params)=>{
  if(!readMethods.has(method))throw Error('Gift recovery permits confirmation reads only.');
  return rpc(method,params);
 };
}

// Bounded sequential work keeps catalog/interactive checkout ahead of recovery.
// Counts only: never return invoice credentials, email, redemption code or URL.
export async function reconcileGiftBatch(deps:Dependencies,signal:AbortSignal,max=5){
 if(!Number.isInteger(max)||max<1||max>20)throw Error('Invalid gift recovery budget.');
 const result={checked:0,delivered:0,refunded:0,paymentVerified:0,retry:0};
 if(signal.aborted)return result;
 const now=deps.now||Date.now,deadline=now()+40000;
 const rows=await deps.candidates(max);
 if(!Array.isArray(rows)||rows.length>max)throw Error('Gift recovery exceeded its batch.');
 for(const row of rows){
  if(signal.aborted||now()>=deadline)break;
  try{
   const status=await deps.reconcile(row.wallet,row.id);result.checked++;
   if(status.delivery==='delivered')result.delivered++;
   if(status.delivery==='refunded')result.refunded++;
   if(status.payment==='verified')result.paymentVerified++;
   if(status.delivery==='unavailable'||status.payment==='unavailable')result.retry++;
  }catch{result.retry++;}
 }
 return result;
}

// Hook into the existing recovery process. This factory does not start a
// server, create another paid worker or change admission of new purchases.
export function giftCheckoutRecovery(env:Record<string,string|undefined>=process.env){
 if(env.GIFT_CHECKOUT_RECOVERY_ENABLED!=='true')return null;
 if(!env.DATABASE_URL||!env.BITREFILL_ORDER_SECRET||!env.BITREFILL_CLIENT_ID||!env.BITREFILL_CLIENT_SECRET||!(env.PAY_TRANSFER_RPC_URL||env.SOLANA_RPC_URL))throw Error('Gift recovery configuration is incomplete.');
 const url=env.DATABASE_URL;
 const store=giftCheckoutStore(url,env.BITREFILL_ORDER_SECRET);
 const service=giftCheckoutService(store,bitrefillCatalog({env:()=>env}),payTransferService(payTransferStore(url),giftRecoveryRpc(payRpc((method,params)=>rpcRequest(method,params,env.PAY_TRANSFER_RPC_URL||env.SOLANA_RPC_URL)))));
 return {
  tick:(signal:AbortSignal)=>reconcileGiftBatch({
   candidates:async limit=>{
    const sql=neon(url,{fetchOptions:{signal:AbortSignal.any([signal,AbortSignal.timeout(8000)])}});
    const rows=await sql`SELECT id,wallet FROM fub_gift_purchases WHERE state='ready' AND closed_at IS NULL AND next_check_at<=clock_timestamp() ORDER BY next_check_at,created_at,id LIMIT ${limit}`;
    return rows.map(row=>({id:row.id as string,wallet:row.wallet as string}));
   },
   reconcile:(wallet,id)=>service.reconcile(wallet,id),
  },signal),
 };
}
