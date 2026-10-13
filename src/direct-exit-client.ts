import {matchesFubOrigin} from './fub-origin.js';
import {isLimitBuy,EXIT_TOKEN_2022,directExitMessage,exitRaw,validateExitTerms,type DirectExitTerms} from './direct-exits';
import {USDC,WSOL,TOKEN_PROGRAM} from './funding-model';
export type ExitBalanceReview={solBalanceRaw?:string;buyEnabled?:boolean;pilotOrders?:DirectExitTerms[];wallet:string;mint:string;outputMint?:string;tokenProgram?:string;balanceRaw:string;decimals:number;slot:number;checkedAt:number;expiresAt:number;permissionReady:boolean;executionEnabled:boolean};
export type ExitOrderView={terms:DirectExitTerms;state:'watching'|'signing'|'signed'|'submitted'|'confirmed'|'failed'|'cancelled'|'expired'|'uncertain';highRaw:string|null;observedAt:number|null;leg:'target'|'stop'|'trailing'|null;signature:string|null};
export function exitUnits(raw:string,decimals:number){
 const text=raw.padStart(decimals+1,'0');return decimals?`${text.slice(0,-decimals)}.${text.slice(-decimals)}`.replace(/\.?0+$/,''):text;
}
export function exitAmount(value:string,decimals:number){
 if(!Number.isInteger(decimals)||decimals<0||decimals>18||typeof value!=='string'||value.length>60||!/^\d+(\.\d+)?$/.test(value.trim()))throw Error('Enter a positive amount without commas or exponent notation.');
 const [whole,fraction='']=value.trim().split('.');
 if(fraction.length>decimals)throw Error(`This amount supports at most ${decimals} decimal places.`);
 const raw=BigInt(whole+fraction.padEnd(decimals,'0')).toString();exitRaw(raw);return raw;
}
export function exitBalanceReview(value:unknown,wallet:string,mint:string,now=Date.now()):ExitBalanceReview{
 const r=value as ExitBalanceReview;
 if(r?.tokenProgram!==undefined&&![TOKEN_PROGRAM,'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].includes(r.tokenProgram))throw Error('Unsupported token program.');
 if(r?.outputMint!==undefined&&![USDC,WSOL].includes(r.outputMint))throw Error('Unsupported exit proceeds.');
 if(!r||r.wallet!==wallet||r.mint!==mint||!Number.isInteger(r.decimals)||r.decimals<0||r.decimals>18||!Number.isSafeInteger(r.slot)||r.slot<1||!Number.isSafeInteger(r.checkedAt)||r.checkedAt>now+5000||r.checkedAt<now-60000||!Number.isSafeInteger(r.expiresAt)||r.expiresAt<=now||r.expiresAt>now+65000||typeof r.permissionReady!=='boolean'||typeof r.executionEnabled!=='boolean')throw Error('The holding review does not match this wallet or is stale.');
 exitRaw(r.balanceRaw,true);
 if(r.solBalanceRaw!==undefined)exitRaw(r.solBalanceRaw,true);if(r.buyEnabled!==undefined&&typeof r.buyEnabled!=='boolean')throw Error('Invalid buy availability.');
 if(r.pilotOrders!==undefined){
  if(!Array.isArray(r.pilotOrders)||r.pilotOrders.length>2)throw Error('Invalid test orders.');
  for(const t of r.pilotOrders){validateExitTerms(t);if(t.wallet!==wallet||t.mint!==mint||t.tokenDecimals!==r.decimals)throw Error('Test order does not match the holding.');}
 }
 return r;
}
export function exitOrderList(value:unknown,wallet:string,origin:string):{orders:ExitOrderView[];executionEnabled:boolean;buyExecutionEnabled:boolean}{
 const r=value as {wallet:string;orders:ExitOrderView[];executionEnabled:boolean;buyExecutionEnabled?:boolean};
 if(!r||r.wallet!==wallet||r.buyExecutionEnabled!==undefined&&typeof r.buyExecutionEnabled!=='boolean'||typeof r.executionEnabled!=='boolean'||!Array.isArray(r.orders)||r.orders.length>100)throw Error('Order history could not be verified.');
 const ids=new Set<string>();
 for(const o of r.orders){
  validateExitTerms(o.terms);
  if(o.terms.wallet!==wallet||!matchesFubOrigin(o.terms.origin,origin)||ids.has(o.terms.id)||!['watching','signing','signed','submitted','confirmed','failed','cancelled','expired','uncertain'].includes(o.state)||!(o.highRaw===null||typeof o.highRaw==='string')||!(o.observedAt===null||Number.isSafeInteger(o.observedAt)&&o.observedAt>0)||![null,'target','stop','trailing'].includes(o.leg)||!(o.signature===null||typeof o.signature==='string'&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(o.signature)))throw Error('Order history did not match this wallet.');
  if(o.highRaw!==null)exitRaw(o.highRaw);ids.add(o.terms.id);
 }
 return {orders:r.orders,executionEnabled:r.executionEnabled,buyExecutionEnabled:r.buyExecutionEnabled===true};
}
export type ExitDraft={amount:string;kind:'limit'|'bracket'|'trailing';target:string;stop:string;trail:string;slippage:string;duration:number};
export function buildExitTerms(d:ExitDraft,r:ExitBalanceReview,origin:string,now=Date.now()):DirectExitTerms{
 if(r.expiresAt<=now)throw Error('Check this holding again before reviewing the order.');
 const amountRaw=exitAmount(d.amount,r.decimals);
 const native=r.outputMint===WSOL,places=native?9:6;
 if(BigInt(amountRaw)>BigInt(r.balanceRaw))throw Error('The sell amount exceeds this wallet’s verified holding.');
 const t:DirectExitTerms={...(native?{version:5 as const,outputMint:WSOL,tokenProgram:r.tokenProgram===TOKEN_PROGRAM?TOKEN_PROGRAM:EXIT_TOKEN_2022}:{version:1 as const}),id:crypto.randomUUID(),origin,wallet:r.wallet,mint:r.mint,amountRaw,tokenDecimals:r.decimals,kind:d.kind,targetRaw:d.kind!=='trailing'?exitAmount(d.target,places):null,stopRaw:d.kind==='bracket'?exitAmount(d.stop,places):null,trailingBps:d.kind==='trailing'?Number(exitAmount(d.trail,2)):null,slippageBps:Number(exitAmount(d.slippage,2)),maxFeeLamports:'500000',maxRentLamports:native?'3000000':'2500000',issuedAt:now,expiresAt:now+d.duration};
 validateExitTerms(t);return t;
}
export function sameExitTerms(a:DirectExitTerms,b:DirectExitTerms){return directExitMessage(a)===directExitMessage(b);}
export function exitStatus(o:ExitOrderView,enabled:boolean,now=Date.now()){
 const labels={signing:'Signing',signed:'Signed',submitted:'Checking settlement',confirmed:'Sold',failed:'Transaction failed',cancelled:'Cancelled',expired:'Expired',uncertain:'Needs confirmation'};
 if(o.state==='confirmed'&&isLimitBuy(o.terms))return 'Bought';
 if(o.state!=='watching')return labels[o.state];
 if(o.terms.expiresAt<=now)return 'Expired';
 if(!enabled)return 'Execution paused';
 if(o.observedAt===null)return 'Awaiting first quote';
 if(now-o.observedAt>60000)return 'Quote check overdue';
 return 'Watching';
}

export function buildPilotExitTerms(template:DirectExitTerms,r:ExitBalanceReview,origin:string,now=Date.now()):DirectExitTerms{
 const t={...template,issuedAt:now};validateExitTerms(t);
 if(r.expiresAt<=now||t.expiresAt<=now||template.issuedAt>now||t.origin!==origin||t.wallet!==r.wallet||t.mint!==r.mint||t.tokenDecimals!==r.decimals||(t.version!==2&&t.version!==3)||(t.version===3&&t.tokenProgram!==r.tokenProgram)||t.outputMint!==r.outputMint||!r.pilotOrders?.some(o=>sameExitTerms(o,template))||BigInt(t.amountRaw)>BigInt(r.balanceRaw))throw Error('This test order or holding has expired or changed.');
 return t;
}

export function buildLimitBuyTerms(d:ExitDraft,r:ExitBalanceReview,origin:string,now=Date.now()):DirectExitTerms{
 if(r.expiresAt<=now)throw Error('Check this token again before reviewing the order.');
 if(r.outputMint!==WSOL||![TOKEN_PROGRAM,EXIT_TOKEN_2022].includes(r.tokenProgram??''))throw Error('This token does not support same-wallet limit buys.');
 const t:DirectExitTerms={version:6,outputMint:r.mint,tokenProgram:r.tokenProgram as typeof TOKEN_PROGRAM|typeof EXIT_TOKEN_2022,id:crypto.randomUUID(),origin,wallet:r.wallet,mint:r.mint,amountRaw:exitAmount(d.amount,9),tokenDecimals:r.decimals,kind:'limit',targetRaw:exitAmount(d.target,r.decimals),stopRaw:null,trailingBps:null,slippageBps:Number(exitAmount(d.slippage,2)),maxFeeLamports:'500000',maxRentLamports:'7500000',issuedAt:now,expiresAt:now+d.duration};
 validateExitTerms(t);assertOrderFunding(t,r);return t;
}
export function assertOrderFunding(t:DirectExitTerms,r:ExitBalanceReview){
 if(t.wallet!==r.wallet||t.mint!==r.mint||t.tokenDecimals!==r.decimals||('tokenProgram' in t&&t.tokenProgram!==r.tokenProgram))throw Error('Token or wallet changed.');
 if(isLimitBuy(t)){
  if(r.solBalanceRaw===undefined||exitRaw(r.solBalanceRaw,true)<exitRaw(t.amountRaw)+exitRaw(t.maxFeeLamports)+exitRaw(t.maxRentLamports,true))throw Error('Not enough SOL for this buy, network fees and account rent.');
 }else if((r.outputMint??USDC)!==exitProceedsMint(t)||exitRaw(r.balanceRaw,true)<exitRaw(t.amountRaw))throw Error('The sell amount exceeds the verified holding.');
}
function exitProceedsMint(t:DirectExitTerms){return t.version===1?USDC:WSOL;}
