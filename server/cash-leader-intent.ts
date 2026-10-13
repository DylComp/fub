import {getOrderId} from '../vendor/relay-order.mjs';
import type {Order} from '@relay-protocol/settlement-sdk';
import {CASH_MINT,type CashNetwork} from '../src/cash-route.js';
import {isMint} from '../src/assets.js';
import {cashReturnNetwork} from './cash-return-networks.js';
import {readCashLeaderDeposit,readCashLeaderProvisionalDeposit} from './cash-leader-deposit.js';
import type {readCashLeaderFill} from './cash-leader-fill.js';
import type {Rpc} from './funding.js';
type Fill=NonNullable<Awaited<ReturnType<typeof readCashLeaderFill>>>;
const same=(a:unknown,b:string)=>typeof a==='string'&&a.toLowerCase()===b.toLowerCase();
const object=(v:any)=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Missing leader order.');return v;};
const one=(v:any)=>{if(!Array.isArray(v)||v.length!==1)throw Error('Ambiguous leader order.');return object(v[0]);};
const raw=(v:any)=>{if(typeof v!=='string'||! /^(0|[1-9]\d{0,77})$/.test(v)||BigInt(v)>=2n**256n)throw Error('Invalid leader order amount.');return BigInt(v);};
const vms={solana:'solana-vm',base:'ethereum-vm',bnb:'ethereum-vm',monad:'ethereum-vm',robinhood:'ethereum-vm',arc:'ethereum-vm',ethereum:'ethereum-vm'} as const;

/** Checks untrusted order payloads against the leader's signed Solana deposit.
 * The order can come from any index: its labels are not authority. The hash
 * commits the source payment, destination currency, recipient and minimum.
 * This function does not fetch an index, schedule, sign or submit trades.
 * Consumers must reserve orderId once per plan, independently of fill hashes,
 * and establish canonical receipt/reorg policy before enabling execution. */
type IntentInput={fill:Fill;sourceWallet:string;sourceSignature:string;blockTime:number;orderData:unknown};
export function readCashLeaderIntent(input:IntentInput,solana:Rpc){return readIntent(input,solana,readCashLeaderDeposit);}
export async function readCashLeaderProvisionalIntent(input:IntentInput,solana:Rpc,now=Date.now){
 if(now()-input.blockTime>10000||now()<input.blockTime)throw Error('Leader fill is stale.');
 const intent=await readIntent(input,solana,(i,rpc)=>readCashLeaderProvisionalDeposit(i,rpc,now));
 if(now()-input.blockTime>10000||now()<input.blockTime)throw Error('Leader verification expired.');
 return intent?{...intent,confirmation:'provisional' as const}:null;
}
async function readIntent(input:IntentInput,solana:Rpc,readDeposit:typeof readCashLeaderDeposit){
 const {fill,sourceWallet,sourceSignature,blockTime}=input;
 if(!isMint(sourceWallet)||!Number.isSafeInteger(blockTime)||blockTime<=0||!fill||fill.swapVerified!==true||fill.tradeVerified!==false)throw Error('Invalid leader intent request.');
 const cfg=cashReturnNetwork(fill.network as CashNetwork),o=object(input.orderData);
 const payment=object(one(o.inputs).payment),out=object(o.output),delivery=one(out.payments);
 const routerWord='0x'+cfg.router.slice(2).padStart(64,'0');
 if(o.version!=='v1'||o.solverChainId!=='base'||!same(o.solver,cfg.solver)||!/^0x[0-9a-f]{64}$/i.test(o.salt)||!Array.isArray(o.fees)||o.fees.length||payment.chainId!=='solana'||payment.currency!==CASH_MINT||payment.weight!=='1'||raw(payment.amount)<=0n||raw(payment.amount)>=2n**64n||out.chainId!==cfg.protocol||!Array.isArray(out.calls)||out.calls.length||!same(out.extraData,routerWord)||!same(delivery.recipient,fill.recipient)||!same(delivery.currency,fill.token)||raw(delivery.minimumAmount)<=0n||raw(delivery.expectedAmount)<raw(delivery.minimumAmount)||raw(delivery.minimumAmount)>BigInt(fill.outputRaw))throw Error('Leader order intent differs from its fill.');
 if(!Number.isSafeInteger(out.deadline)||out.deadline*1000<blockTime||out.deadline*1000-blockTime>8*86400000)throw Error('Leader order deadline differs.');
 const refunds=o.inputs[0].refunds;
 if(!Array.isArray(refunds)||refunds.length!==2)throw Error('Leader order refunds differ.');
 const source=refunds.find((r:any)=>r.chainId==='solana'),destination=refunds.find((r:any)=>r.chainId===cfg.protocol);
 if(!source||!destination||source.recipient!==sourceWallet||source.currency!==CASH_MINT||source.extraData!=='0x'||!same(destination.recipient,fill.recipient)||!same(destination.currency,cfg.usdc)||!same(destination.extraData,routerWord)||refunds.some((r:any)=>r.minimumAmount!=='0'||r.deadline!==out.deadline))throw Error('Leader order refund recipient differs.');
 const orderId=getOrderId(o as Order,vms);
 if(!same(orderId,fill.orderIdHint))throw Error('Leader order commitment differs.');
 const paid=await readDeposit({wallet:sourceWallet,signature:sourceSignature,orderId,amountRaw:payment.amount},solana);
 if(!paid)return null;
 if(paid.blockTime>blockTime+30000||blockTime-paid.blockTime>30000)throw Error('Leader payment does not match the fill time.');
 return{intentVerified:true as const,executionEnabled:false as const,network:fill.network,recipient:fill.recipient,token:fill.token,orderId,sourceSignature:paid.signature,sourceAmountRaw:paid.amountRaw,sourceSlot:paid.slot,fillTransaction:fill.transaction,requiredDedupeKey:[sourceWallet,orderId].join(':')};
}
