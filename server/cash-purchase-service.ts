import {cashPublicSaleId} from './cash-public-id.js';
import {ChainRpcError} from './funding.js';
import {recoverUnreportedCashDeposit} from './cash-abandoned.js';
import { cashQuoteRequest } from './cash-route.js';
import { prepareCashDeposit, simulateCashDeposit, inspectSignedCashDeposit } from './cash-deposit.js';
import { finalizedCashDeposit, readCashDelivery, readCashRefund } from './cash-receipt.js';
import {cashRelay} from './cash-relay.js';
import { reconcileCashSettlement } from '../src/cash-recovery.js';
import type { CashRouteIntent, CashNetwork } from '../src/cash-route.js';
import type { CashWalletBinding } from './cash-wallet-binding.js';
import type { CashPurchaseStore, CashPurchase } from './cash-purchase-store.js';
import type { Rpc } from './funding.js';
const uuid=(v:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const terminal=(p:CashPurchase)=>['expired','complete','refunded','reverted'].includes(p.state);
export function cashPurchaseService(config:{store:CashPurchaseStore;solana:Rpc;evm:(network:CashNetwork)=>Rpc;
  // Server-side consumed ownership proof, never a browser-supplied boolean.
  binding:(wallet:string,network:CashNetwork)=>Promise<CashWalletBinding|null>;
  enabled:()=>boolean;fetcher?:typeof fetch;now?:()=>number;
}, dependencies={prepare:prepareCashDeposit,simulate:simulateCashDeposit,deposit:finalizedCashDeposit,delivery:readCashDelivery,refund:readCashRefund}){
 const {store,solana}=config,fetcher=config.fetcher||fetch,now=config.now||Date.now;
 async function ownership(intent:CashRouteIntent){
  const binding=await config.binding(intent.sourceWallet,intent.network);
  if(!binding||binding.expiresAt<=now()||binding.verifiedAt>now()||binding.sourceWallet!==intent.sourceWallet||binding.recipient!==intent.recipient.toLowerCase()||binding.network!==intent.network)
   throw Error('Confirm ownership of both trading wallets.');
  return binding;
 }
 async function broadcast(p:CashPurchase){
  for(let attempt=0;;attempt++){
   try{return await solana('sendTransaction',[p.signed,{encoding:'base64',skipPreflight:false,maxRetries:3,preflightCommitment:'finalized',minContextSlot:p.review.slot}]);}
   catch(error){
    if(error instanceof ChainRpcError&&error.code===-32016&&attempt<3){await new Promise(resolve=>setTimeout(resolve,250*2**attempt));continue;}
    console.error(JSON.stringify({event:'cash_deposit_broadcast_unresolved',purchaseId:p.id,rpcCode:error instanceof ChainRpcError?error.code:null}));
    throw error;
   }
  }
 }
 async function recover(p:CashPurchase):Promise<CashPurchase>{
  if(terminal(p))return p;
  if(!p.signed&&!p.signature){
   const recovery=await recoverUnreportedCashDeposit(p.review,solana);
   if(recovery.state==='found')p=await store.bind(p.id,p.wallet,recovery.signed);
   else if(recovery.state==='expired')p=await store.expire(p.id,p.wallet,p.review.blockhash);
   else return p;
  }
  if(!p.signed||!p.signature||terminal(p))return p;
  const deposit=await dependencies.deposit(p.review,p.signed,solana);
  if(deposit==='pending'){
   if(p.state==='submitted'){
    const unused=await recoverUnreportedCashDeposit(p.review,solana);
    if(unused.state==='expired'){
     const status=await solana('getSignatureStatuses',[[p.signature],{searchTransactionHistory:true}]) as any;
     // Missing/pruned/inconsistent answers stay unresolved. The history scan
     // above also checks the unique Relay payment, not just this signature.
     if(Number.isSafeInteger(status?.context?.slot)&&status.context.slot>=p.review.slot&&Array.isArray(status.value)&&status.value.length===1&&status.value[0]===null)
      return store.expireUnlanded(p,now());
    }
   }
   return p;
  }
  if(deposit==='reverted')return store.settle(p.id,p.signature,'reverted');
  const status=await cashRelay(fetcher).status(p.review.quote.requestId) as any;
  let outcome=reconcileCashSettlement(p.review.quote,p.signature,status);
  if(outcome.state==='verify-delivery'||outcome.state==='verify-refund'){
   for(const hash of status.txHashes){
    const receipt=outcome.state==='verify-delivery'?await dependencies.delivery(p.review.quote,hash,config.evm(p.review.quote.network)):
      (/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(hash)?await dependencies.refund(p.review.quote,hash,solana):null);
    if(!receipt)continue;
    const checked=reconcileCashSettlement(p.review.quote,p.signature,status,receipt);
    if(checked.state==='complete'||checked.state==='refunded')return store.settle(p.id,p.signature,checked.state,receipt);
   }
  }
  const state=outcome.state==='delayed'?'delayed':outcome.state==='needs-attention'||outcome.state==='verify-refund'?'needs-attention':'settling';
  return store.settle(p.id,p.signature,state);
 }
 return {
  async prepare(id:string,intent:CashRouteIntent,admission?:'public-v1'){
   if(admission!==undefined&&admission!=='public-v1')throw Error('Invalid cash admission.');
   if(!config.enabled())throw Error('Cash execution is not enabled.');
   if(!uuid(id))throw Error('Invalid cash purchase ID.');
   const binding=await ownership(intent),previous=await store.get(id,intent.sourceWallet);
   if(previous){
    if(previous.review.admission!==admission)throw Error('This purchase belongs to a different execution flow.');
    const old=previous.review.intent;
    if(old.sourceWallet!==intent.sourceWallet||old.recipient.toLowerCase()!==intent.recipient.toLowerCase()||old.network!==intent.network||old.token.toLowerCase()!==intent.token.toLowerCase()||old.amountRaw!==intent.amountRaw||old.slippageBps!==intent.slippageBps||old.gasTopupUsdcRaw!==intent.gasTopupUsdcRaw)throw Error('This cash purchase ID belongs to a different request.');
    const recovered=await recover(previous);
    // Expired means the finalized source-history scan proved no payment.
    // Refresh the same intent only; signed or uncertain attempts stay intact.
    if(recovered.state!=='expired'||recovered.signed||recovered.signature)return recovered;
    const quote=await cashRelay(fetcher).quote(cashQuoteRequest(intent));
    const review=await dependencies.prepare(quote,intent,solana,{maxFeeLamports:recovered.review.maxFeeLamports,maxRentLamports:recovered.review.maxRentLamports},now());
    if(admission){review.admission=admission;review.publicSaleId=cashPublicSaleId(id);}
    return store.refresh(recovered,review,binding);
   }
   const quote=await cashRelay(fetcher).quote(cashQuoteRequest(intent));
   const review=await dependencies.prepare(quote,intent,solana,{maxFeeLamports:'10000',maxRentLamports:'2500000'},now());
   if(admission){review.admission=admission;review.publicSaleId=cashPublicSaleId(id);}
   return store.reserve(id,review,binding);
  },
  async submit(id:string,wallet:string,signed:string){
   if(!uuid(id))throw Error('Invalid cash purchase ID.');
   const saved=await store.get(id,wallet);if(!saved)throw Error('Cash purchase not found.');
   if(saved.state==='expired')throw Error('This unsigned purchase expired. Prepare a fresh purchase.');
   const signature=inspectSignedCashDeposit(saved.review,signed);
   if(saved.signature){if(saved.signature!==signature||saved.signed!==signed)throw Error('A different cash submission is already recorded.');return recover(saved);}
   if(!config.enabled())throw Error('Cash execution is not enabled.');
   await ownership(saved.review.intent);
   await dependencies.simulate(saved.review,solana,signed,now());
   const height=await solana('getBlockHeight',[{commitment:'finalized'}]);
   if(!Number.isSafeInteger(height)||Number(height)>saved.review.lastValidBlockHeight)throw Error('Cash transaction expired before submission.');
   const bound=await store.bind(id,wallet,signed);
   // All recovery information is durable before the first broadcast. A lost
   // response is unresolved, never permission to construct another deposit.
   try{const returned=await broadcast(bound);
    if(returned!==signature)return store.settle(id,signature,'needs-attention');
   }catch{return bound;}
   return bound;
  },
  async status(id:string,wallet:string){if(!uuid(id))throw Error('Invalid cash purchase ID.');const p=await store.get(id,wallet);return p?recover(p):null;},
  async resume(id:string,wallet:string){
   const p=await this.status(id,wallet);if(!p||terminal(p)||!p.signed||!p.signature||!config.enabled())return p;
   await ownership(p.review.intent);
   if(await dependencies.deposit(p.review,p.signed,solana)!=='pending')return recover(p);
   const height=await solana('getBlockHeight',[{commitment:'finalized'}]);
   if(!Number.isSafeInteger(height)||Number(height)>p.review.lastValidBlockHeight)return p;
   // Rebroadcast the exact journaled bytes with RPC preflight. No replacement
   // order, new blockhash or additional amount can be created here.
   try{const returned=await broadcast(p);
    if(returned!==p.signature)return store.settle(p.id,p.signature,'needs-attention');
   }catch{return p;}return recover(p);
  },
  async recoverBatch(){const pending=await store.pending(25);const results=[];for(const p of pending){try{results.push({id:p.id,state:(await recover(p)).state});}catch{results.push({id:p.id,state:'unavailable' as const});}}return results;}
 };
}
