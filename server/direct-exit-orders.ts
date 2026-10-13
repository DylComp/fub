import { isLimitBuy, validateExitTerms, exitProceeds, type DirectExitTerms } from '../src/direct-exits.js';
import { verifyDirectExit } from './direct-exit-authorization.js';
import type { DirectExitRecord, DirectExitStore } from './direct-exit-store.js';
import type { EnrolledWallet } from './signer-enrollment.js';
import type { OwnerBinding } from './privy-owner.js';
import { readDirectExitInventory } from './direct-exit-inventory.js';
import type { Rpc } from './funding.js';
import {readOrderSol} from './direct-order-funding.js';
import {isMint} from '../src/assets.js';
import {USDC,WSOL} from '../src/funding-model.js';
const orderView=(r:DirectExitRecord)=>({terms:r.terms,state:r.state,highRaw:r.watermark.highRaw,observedAt:r.watermark.checkedAt||null,leg:r.leg,signature:r.transactionSignature});
// Internal owner service. The public identity lookup is never authentication.
// Mounted with execution disabled until the complete submission path is ready.
export function directExitOrders(config:{
  pilot?:import('./direct-exit-pilot.js').DirectExitPilot;assertTerms?:(terms:DirectExitTerms)=>void;
  origin:string;store:DirectExitStore;rpc:Rpc;enabled:()=>boolean;buyEnabled?:(wallet:string)=>boolean;allows?:(wallet:string)=>boolean;
  authenticate:(token:string)=>Promise<string>;
  ownership:(binding:Omit<OwnerBinding,'ownerId'>,delegated:boolean,signal:AbortSignal)=>Promise<OwnerBinding>;
  resolveWallet:(wallet:string,issuedAt:number,signal:AbortSignal)=>Promise<EnrolledWallet>;
}){
  return {
    async review(token:string,walletId:string,wallet:string,mint:string,signal:AbortSignal){
      if(!isMint(wallet)||!isMint(mint)||[USDC,WSOL].includes(mint))throw Error('Choose a supported token.');
      const userId=await config.authenticate(token);
      await config.ownership({wallet,walletId,userId},false,signal);
      const balance=await readDirectExitInventory(wallet,mint,config.rpc,true);
      const sol=await readOrderSol(wallet,balance.slot,config.rpc);
      let permissionReady=false;
      try{const owner=await config.resolveWallet(wallet,Date.now(),signal);permissionReady=owner.walletId===walletId;}catch{signal.throwIfAborted();}
      signal.throwIfAborted();
      return {...(config.pilot?{pilotOrders:config.pilot.orders.filter(t=>t.wallet===wallet&&t.mint===mint&&t.expiresAt>Date.now()).map(t=>structuredClone(t))}:{}),wallet,mint,solBalanceRaw:sol.raw,buyEnabled:!!config.buyEnabled?.(wallet),outputMint:balance.outputMint,tokenProgram:balance.tokenProgram,balanceRaw:balance.rawAmount,decimals:balance.decimals,slot:Math.max(balance.slot,sol.slot),checkedAt:balance.fetchedAt,expiresAt:Date.now()+60000,permissionReady,executionEnabled:config.enabled()&&(!config.allows||config.allows(wallet))};
    },
    async activate(token:string,walletId:string,terms:DirectExitTerms,signature:string,signal:AbortSignal){
      const t=structuredClone(terms);validateExitTerms(t);config.assertTerms?.(t);
      if(!config.enabled()||(config.allows&&!config.allows(t.wallet))||t.issuedAt>Date.now()||Date.now()-t.issuedAt>300000||t.expiresAt<=Date.now())throw Error('Direct exits are not available or the review expired.');
      if(isLimitBuy(t)&&!config.buyEnabled?.(t.wallet))throw Error('Limit buys are not enabled.');
      const hash=verifyDirectExit(t,signature,config.origin),userId=await config.authenticate(token);
      await config.ownership({wallet:t.wallet,walletId,userId},true,signal);
      const owner=await config.resolveWallet(t.wallet,t.issuedAt,signal);
      if(owner.walletId!==walletId)throw Error('Provider wallet does not match this order.');
      const balance=await readDirectExitInventory(t.wallet,t.mint,config.rpc,t.version>=3);
      if(balance.decimals!==t.tokenDecimals||('tokenProgram' in t&&balance.tokenProgram!==t.tokenProgram))throw Error('Token precision or program changed.');
      if(isLimitBuy(t)){
        const sol=await readOrderSol(t.wallet,balance.slot,config.rpc);
        if(BigInt(sol.raw)<BigInt(t.amountRaw)+BigInt(t.maxFeeLamports)+BigInt(t.maxRentLamports))throw Error('Not enough SOL for this buy, network fees and account rent.');
      }else if(balance.outputMint!==exitProceeds(t).mint||BigInt(balance.rawAmount)<BigInt(t.amountRaw))throw Error('Token amount, settlement asset or precision does not match this wallet.');
      await owner.check(signal);signal.throwIfAborted();
      if(!config.enabled()||t.expiresAt<=Date.now()||Date.now()-t.issuedAt>300000)throw Error('Direct exit activation stopped.');
      config.assertTerms?.(t);
      await config.store.create(t,hash,signature,userId);
      return {id:t.id,state:(await config.store.get(t.id))!.state};
    },
    async recover(token:string,walletId:string,terms:DirectExitTerms,signature:string,signal:AbortSignal){
      const t=structuredClone(terms),hash=verifyDirectExit(t,signature,config.origin),userId=await config.authenticate(token);
      await config.ownership({wallet:t.wallet,walletId,userId},false,signal);signal.throwIfAborted();
      let row=await config.store.get(t.id);
      if(!row&&Math.min(t.issuedAt+300000,t.expiresAt)<=Date.now())row=await config.store.expireApproval(t,hash,signature,userId);
      signal.throwIfAborted();
      if(row&&(row.userId!==userId||row.termsHash!==hash||row.signature!==signature))throw Error('Order recovery identity changed.');
      let retryAllowed=false;
      if(!row&&config.enabled()&&(!config.allows||config.allows(t.wallet))&&(!isLimitBuy(t)||config.buyEnabled?.(t.wallet))&&t.issuedAt<=Date.now()&&Date.now()-t.issuedAt<=300000&&t.expiresAt>Date.now()){
        try{config.assertTerms?.(t);await config.ownership({wallet:t.wallet,walletId,userId},true,signal);const owner=await config.resolveWallet(t.wallet,t.issuedAt,signal);await owner.check(signal);retryAllowed=owner.walletId===walletId&&config.enabled()&&(!config.allows||config.allows(t.wallet))&&(!isLimitBuy(t)||!!config.buyEnabled?.(t.wallet))&&t.expiresAt>Date.now()&&Date.now()-t.issuedAt<=300000;}catch{signal.throwIfAborted();}
      }
      return {wallet:t.wallet,id:t.id,retryAllowed,checkedAt:Date.now(),executionEnabled:config.enabled()&&(!config.allows||config.allows(t.wallet)),buyExecutionEnabled:!!config.buyEnabled?.(t.wallet),orders:row?[orderView(row)]:[]};
    },
    async list(token:string,wallet:string){
      const userId=await config.authenticate(token);
      if(!isMint(wallet))throw Error('Invalid wallet.');
      return {wallet,buyExecutionEnabled:!!config.buyEnabled?.(wallet),executionEnabled:config.enabled()&&(!config.allows||config.allows(wallet)),orders:(await config.store.list(wallet,userId)).map(orderView)};
    },
    async cancel(token:string,id:string){
      const userId=await config.authenticate(token);
      if(!await config.store.cancel(id,userId))throw Error('This exit has already begun signing or is unavailable. Check its status.');
      return {id,state:'cancelled' as const};
    },
  };
}
