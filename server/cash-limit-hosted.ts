import {inspectCashLimitPartialSale} from './cash-limit-partial-sale.js';
import {privateCashNonceClaim,reserveCashEvmNonce} from './cash-nonce-reservation.js';
import {inspectCashLimitPurchaseDelivery,inspectCashLimitSaleDelivery} from './cash-limit-delivery-review.js';
import {validateCashLimitDelivery,type CashLimitDelivery} from './cash-limit-delivery.js';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {isCashNetwork,type CashNetwork} from '../src/cash-route.js';
import type {CashLimitTerms,CashLimitObservation} from '../src/cash-limit-model.js';
import {privyAccessVerifier,privyOwnershipReader,type SignerPolicy} from './privy-owner.js';
import {privyCashOwnershipReader} from './privy-cash-owner.js';
import {privySignOnly} from './privy-sign-only.js';
import {privyEvmSignOnly} from './privy-evm-sign-only.js';
import {cashLimitStore} from './cash-limit-store.js';
import {cashLimitEnrollment} from './cash-limit-enrollment.js';
import {cashLimitApi} from './cash-limit-api.js';
import {cashLimitSigning} from './cash-limit-signing.js';
import {cashLimitSigningParts} from './cash-limit-signing-parts.js';
import {cashLimitService,type CashLimitExecutionReview} from './cash-limit-service.js';
import {cashLimitScheduler} from './cash-limit-scheduler.js';
import {cashLimitBalances,cashLimitAssetBalances} from './cash-limit-balances.js';
import {cashLimitExecutionStores} from './cash-limit-execution-store.js';
import {cashPurchaseService} from './cash-purchase-service.js';
import {cashReturnService} from './cash-return-service.js';
import type {Rpc} from './funding.js';
type Policy=SignerPolicy&{privateKey:string};
// The execution tables and signing journal use only the isolated signer DB.
export function hostedCashLimits(c:{origin:string;databaseUrl:string;appId:string;appSecret:string;solanaPolicy:Policy;evmPolicy:Policy;
 solana:Rpc;evm:(n:CashNetwork)=>Rpc;enabled:()=>boolean;ready:()=>boolean;price:(t:CashLimitTerms)=>Promise<CashLimitObservation>;shutdown:AbortSignal;networks:CashNetwork[];pilotWallets?:string[]}){
 for(const p of[c.solanaPolicy,c.evmPolicy]){const k=createPrivateKey({key:Buffer.from(p.privateKey,'base64'),format:'der',type:'pkcs8'});if(k.asymmetricKeyType!=='ec'||k.asymmetricKeyDetails?.namedCurve!=='prime256v1'||createPublicKey(k).export({type:'spki',format:'der'}).toString('base64')!==p.publicKey)throw Error('Limit signer key mismatch.');}
 const enabled=()=>c.ready()&&c.enabled()&&!c.shutdown.aborted,store=cashLimitStore<CashLimitExecutionReview>(c.databaseUrl);
 const authenticate=privyAccessVerifier(c.appId),solanaOwnership=privyOwnershipReader({appId:c.appId,appSecret:c.appSecret,policy:c.solanaPolicy}),evmOwnership=privyCashOwnershipReader({appId:c.appId,appSecret:c.appSecret,policy:c.evmPolicy});
 const walletAllowed=(wallet:string)=>!c.pilotWallets?.length||c.pilotWallets.includes(wallet);
 const owner=cashLimitEnrollment({origin:c.origin,store,authenticate,solanaOwnership,evmOwnership,solanaPolicy:c.solanaPolicy,evmPolicy:c.evmPolicy,enabled,walletAllowed});
 const authorized=async(t:CashLimitTerms)=>{if(!enabled()||!walletAllowed(t.sourceWallet)||!c.networks.includes(t.network))return false;try{const signal=AbortSignal.any([c.shutdown,AbortSignal.timeout(10000)]);await Promise.all([owner.resolve(t,'solana',signal),owner.resolve(t,'evm',signal)]);return true;}catch{return false;}};
 const signer=cashLimitSigning({journal:store,parts:cashLimitSigningParts(c.databaseUrl),enabled,authorized,resolveSolana:(t,s)=>owner.resolve(t,'solana',s),resolveEvm:(t,s)=>owner.resolve(t,'evm',s),solana:c.solana,evm:c.evm,solanaProvider:privySignOnly({appId:c.appId,appSecret:c.appSecret,authorizationPrivateKey:c.solanaPolicy.privateKey}),evmProvider:reserveCashEvmNonce(privateCashNonceClaim(c.databaseUrl),privyEvmSignOnly({appId:c.appId,appSecret:c.appSecret,authorizationPrivateKey:c.evmPolicy.privateKey}))});
 const executionStores=cashLimitExecutionStores(c.databaseUrl),{purchases:purchaseStore,sales:saleStore}=executionStores;
 async function tick(id:string){const job=await store.get(id);if(!job)return;const t=job.terms;
  const binding=async(wallet:string,network:CashNetwork)=>{if(wallet!==t.sourceWallet||network!==t.network||!await authorized(t))return null;return{sourceWallet:t.sourceWallet,recipient:t.recipient,network:t.network,verifiedAt:job.grant.acceptedAt,expiresAt:t.expiresAt,accountType:'eoa' as const,tradingAuthorized:false as const};};
  const purchases=cashPurchaseService({store:purchaseStore,solana:c.solana,evm:c.evm,binding,enabled});
  const returns=cashReturnService({store:saleStore,solana:c.solana,evm:c.evm(t.network),evmFor:c.evm,binding,enabled,broadcast:async()=>{throw Error('Private limit signer cannot broadcast.');}});
  const engine=cashLimitService({deliveryOnly:true,journal:store,purchases,returns,purchaseStore,saleStore,enabled,authorized,price:c.price,balances:t=>cashLimitBalances(t,c.evm(t.network)),signer:{sign:id=>signer.sign(id,c.shutdown),recover:signer.recover}});
  await engine.tick(id);
 }
 async function delivery(signal:AbortSignal):Promise<CashLimitDelivery|null>{
  if(!enabled())return null;
  for(const job of await store.deliverable()){
   signal.throwIfAborted();const t=job.terms;if(!await authorized(t))continue;
   try{
    let result:CashLimitDelivery;let originalExpiry:number;const expiresAt=0;
    if(t.side==='buy'){
     const p=await purchaseStore.get(t.id,t.sourceWallet);if(!p?.signed||!p.signature||!['submitted','settling','delayed'].includes(p.state))continue;
     await inspectCashLimitPurchaseDelivery(t,p,c.solana);originalExpiry=p.review.quote.expiresAt;
     result={version:1,orderId:t.id,wallet:t.sourceWallet,network:t.network,expiresAt,side:'buy',unsigned:p.review.unsigned,signed:p.signed,signature:p.signature,slot:p.review.slot};
    }else{
     const p=await saleStore.get(t.id,t.sourceWallet);if(!p?.signed||!p.hashes||!['submitted','settling','delayed'].includes(p.state))continue;
     const returns=cashReturnService({store:saleStore,solana:c.solana,evm:c.evm(t.network),evmFor:c.evm,binding:async()=>null,enabled:()=>false,broadcast:async()=>{throw Error('Signer cannot broadcast.');}});
     await inspectCashLimitSaleDelivery(t,p,{balances:()=>cashLimitBalances(t,c.evm(t.network)),partial:()=>inspectCashLimitPartialSale(p,c.evm(t.network)),inspect:()=>returns.inspectPrepared(p)});originalExpiry=Math.min(p.simulation.expiresAt,p.gas.expiresAt);
     result={version:1,orderId:t.id,wallet:t.sourceWallet,network:t.network,expiresAt,side:'sell',transactions:p.gas.transactions,signed:p.signed,hashes:p.hashes};
    }
    if(!await authorized(t))continue;signal.throwIfAborted();return await finishCashLimitDelivery(result,Math.min(t.expiresAt,originalExpiry));
   }catch{continue;}
  }return null;
 }
 const scheduler=cashLimitScheduler({due:async()=>{await executionStores.retireExpiredUnsignedBatch();return store.due();},tick});
 return{delivery,api:cashLimitApi({origin:c.origin,configuration:async(token,b,signal)=>{if(!walletAllowed(b.wallet))throw Error('Limit access is not available for this wallet.');if(!isCashNetwork(b.network)||!c.networks.includes(b.network))throw Error('Limit network unavailable.');const userId=await authenticate(token);await Promise.all([solanaOwnership({userId,wallet:b.wallet,walletId:b.walletId},false,signal),evmOwnership({userId,wallet:b.recipient,walletId:b.evmWalletId},false,signal)]);const balances=await cashLimitAssetBalances(b.network,b.token,b.recipient,c.evm(b.network));signal.throwIfAborted();return{enabled:enabled(),networks:c.networks,tokenDecimals:balances.tokenDecimals,tokenBalanceRaw:balances.tokenRaw,gasBalanceRaw:balances.gasRaw,solana:{signerId:c.solanaPolicy.signerId,policyId:c.solanaPolicy.policyId},evm:{signerId:c.evmPolicy.signerId,policyId:c.evmPolicy.policyId}};},service:{...owner,activate:async(...args:Parameters<typeof owner.activate>)=>{if(!c.networks.includes(args[1].network))throw Error('Limit network unavailable.');return owner.activate(...args);}}}),start:scheduler.start,stop:scheduler.stop,status:()=>({enabled:enabled(),networks:c.networks,...scheduler.status()}),tick};
}

// Create the short transport lease only after live checks and final ownership
// verification. The lease cannot extend the signed route or grant deadline.
export async function finishCashLimitDelivery(delivery:CashLimitDelivery,originalExpiry:number,now=Date.now()){
 if(!Number.isSafeInteger(originalExpiry)||originalExpiry<=now)throw Error('Limit delivery authorization expired.');
 const ready={...delivery,expiresAt:Math.min(now+8000,originalExpiry)};
 await validateCashLimitDelivery(ready,now);return ready;
}
