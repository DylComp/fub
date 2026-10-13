import {CASH_MINT,CASH_NETWORKS,RELAY_SOLANA,isCashNetwork,type CashNetwork} from './cash-route.js';
export type CashCopyReceipt={chainId:number;transaction:string;currency:string;receivedRaw:string};
export type CashCopyTrade={id:string;network:CashNetwork;token:string;side:'buy'|'sell';observedAt:number;leaderTransaction:string;amountRaw:string;tokenDecimals:number|null;state:'reserved'|'prepared'|'signing'|'submitted'|'complete'|'needs-attention'|'stopped';outcome:'complete'|'refunded'|'reverted'|null;receipt:null|CashCopyReceipt;returnedCash?:CashCopyReceipt};
export type CashCopyHistory={planId:string;trades:CashCopyTrade[];nextCursor:string|null};
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const evm=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-f]{40}$/.test(v);
const hash=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-f]{64}$/i.test(v);
const raw=(v:unknown)=>typeof v==='string'&&/^(0|[1-9]\d{0,77})$/.test(v)&&BigInt(v)<2n**256n;
export function readCashCopyHistory(value:unknown,planId:string):CashCopyHistory{
 const h=value as CashCopyHistory;
 if(!h||h.planId!==planId||!uuid(planId)||!Array.isArray(h.trades)||h.trades.length>20||h.nextCursor!==null&&!uuid(h.nextCursor))throw Error('Trade history could not be verified.');
 for(const t of h.trades){
  if(!uuid(t.id)||!isCashNetwork(t.network)||!evm(t.token)||!['buy','sell'].includes(t.side)||!Number.isSafeInteger(t.observedAt)||t.observedAt<=0||!hash(t.leaderTransaction)||!raw(t.amountRaw)||BigInt(t.amountRaw)<=0n||t.tokenDecimals!==null&&(!Number.isInteger(t.tokenDecimals)||t.tokenDecimals<0||t.tokenDecimals>36)||!['reserved','prepared','signing','submitted','complete','needs-attention','stopped'].includes(t.state)||t.outcome!==null&&!['complete','refunded','reverted'].includes(t.outcome))throw Error('Trade history could not be verified.');
  if(t.returnedCash!==undefined){const r=t.returnedCash;if(!r||typeof r!=='object'||t.side!=='sell'||t.outcome!==null||!['submitted','needs-attention'].includes(t.state)||r.chainId!==RELAY_SOLANA||r.currency!==CASH_MINT||!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(r.transaction)||!raw(r.receivedRaw)||BigInt(r.receivedRaw)<=0n)throw Error('Returned cash receipt could not be verified.');}
  const r=t.receipt;
  if((t.outcome==='complete'||t.outcome==='refunded')!==!!r)throw Error('Final trade receipt is missing.');
  if(r){
   const sol=r.chainId===RELAY_SOLANA;
   if(!['complete','refunded'].includes(t.outcome||'')||!raw(r.receivedRaw)||BigInt(r.receivedRaw)<=0n||sol&&(!/^[1-9A-HJ-NP-Za-km-z]{87,88}$/.test(r.transaction)||r.currency!==CASH_MINT))throw Error('Trade receipt could not be verified.');
   if(!sol&&(r.chainId!==CASH_NETWORKS[t.network].chainId||!hash(r.transaction)||!evm(r.currency)))throw Error('Trade receipt could not be verified.');
   if(t.outcome==='complete'&&(t.side==='buy'?(sol||r.currency!==t.token):!sol))throw Error('Trade receipt changed its destination.');
  }
 }
 if(new Set(h.trades.map(t=>t.id)).size!==h.trades.length||h.nextCursor!==null&&(h.trades.length!==20||h.trades.at(-1)?.id!==h.nextCursor))throw Error('Trade history pagination changed.');
 return h;
}
export function cashCopyAmount(raw:string,decimals:number):string{
 if(!/^(0|[1-9]\d{0,77})$/.test(raw)||!Number.isInteger(decimals)||decimals<0||decimals>36)throw Error('Invalid amount.');
 const n=BigInt(raw),scale=10n**BigInt(decimals),fraction=String(n%scale).padStart(decimals,'0').replace(/0+$/,'');return String(n/scale)+(fraction?'.'+fraction:'');
}
export function cashCopyTradeLabel(t:CashCopyTrade){
 if(t.state==='needs-attention')return 'Needs attention';
 if(t.returnedCash)return 'USDC returned; awaiting sale finality';
 if(t.outcome==='refunded')return 'Refund confirmed';
 if(t.outcome==='reverted')return 'Transaction reverted';
 return {reserved:'Queued',prepared:'Prepared',signing:'Confirming submission',submitted:'Awaiting delivery',complete:'Complete','needs-attention':'Needs attention',stopped:'Not executed'}[t.state];
}
