import {readCashCopyHistory,type CashCopyTrade} from '../src/cash-copy-history.js';
import canonicalize from 'canonicalize';
import {keccak256} from 'viem';
import {CASH_MINT,RELAY_SOLANA} from '../src/cash-route.js';
import type {CashCopyDocument} from './cash-copy-journal.js';
// Whitelist projection. Never send grants, proofs, signed bytes, provider IDs,
// execution reviews, internal error messages or unfinalized receipts to a client.
// A finalized Solana return may be shown separately while its EVM sale awaits
// source finality. It is not a completed-trade outcome.
export function cashCopyHistory(document:CashCopyDocument,after:string|null){
 const observed=(j:CashCopyDocument['jobs'][string])=>{
  const first=j.unsignedSaleAttempts?.[0]?.event;if(!first)return j.event.observedAt;
  const fields=(e:typeof first)=>{const{observedAt,confirmation,...rest}=e;return rest;};
  if(canonicalize(fields(first))!==canonicalize(fields(j.event))||!Number.isSafeInteger(first.observedAt)||first.observedAt<first.blockTime||first.observedAt>j.event.observedAt)throw Error('Recovered trade identity changed.');
  return first.observedAt;
 };
 const jobs=Object.values(document.jobs).sort((a,b)=>observed(b)-observed(a)||b.id.localeCompare(a.id));
 const offset=after===null?0:jobs.findIndex(j=>j.id===after)+1;
 if(after!==null&&!offset)throw Error('History cursor is no longer available.');
 const page=jobs.slice(offset,offset+21),trades:CashCopyTrade[]=page.slice(0,20).map(j=>{
  const result=j.event.side==='buy'?j.purchase:j.sale;
  const outcome=result&&['complete','refunded','reverted'].includes(result.state)?result.state as CashCopyTrade['outcome']:null;
  const r=result?.receipt;
  if(r&&(!r.finalized||!r.successful||r.recipient!==(r.chainId===RELAY_SOLANA?j.scope.sourceWallet:j.scope.recipient)))throw Error('Unverified receipt.');
  let returnedCash:CashCopyTrade['returnedCash'];
  if(!outcome&&j.provisionalDebit){
   const p=j.provisionalDebit,c=p.cash;
   if(j.event.side!=='sell'||!['submitted','needs-attention'].includes(j.state)||!Array.isArray(j.signed)||!j.signed.length||!/^0x[0-9a-f]+$/i.test(j.signed.at(-1)!)||p.sourceTransaction!==keccak256(j.signed.at(-1)! as `0x${string}`)||!/^0x[0-9a-f]{64}$/.test(p.sourceBlockHash)||!/^0x(0|[1-9a-f][0-9a-f]*)$/.test(p.sourceBlockNumber)||p.debitRaw!==j.amountRaw||!j.sale||c.requestId!==j.sale.simulation.route.requestId||!c.finalized||!c.successful||c.chainId!==RELAY_SOLANA||c.recipient!==j.scope.sourceWallet||c.currency!==CASH_MINT||!/^([1-9][0-9]*)$/.test(c.receivedRaw)||BigInt(c.receivedRaw)<BigInt(j.sale.simulation.route.minimumRaw))throw Error('Unverified returned cash receipt.');
   returnedCash={chainId:c.chainId,transaction:c.transaction,currency:c.currency,receivedRaw:c.receivedRaw};
  }
  const decimals=j.purchase?.review.quote.outputDecimals??jobs.find(b=>b.event.side==='buy'&&b.event.network===j.event.network&&b.event.token===j.event.token&&b.purchase)?.purchase?.review.quote.outputDecimals??null;
  return {id:j.id,network:j.event.network,token:j.event.token,side:j.event.side,observedAt:observed(j),leaderTransaction:j.event.transaction,amountRaw:j.amountRaw,tokenDecimals:decimals,state:j.state,outcome,receipt:r?{chainId:r.chainId,transaction:r.transaction,currency:r.currency,receivedRaw:r.receivedRaw}:null,...(returnedCash?{returnedCash}:{})};
 });
 return readCashCopyHistory({planId:document.grant.scope.planId,trades,nextCursor:page.length>20?trades.at(-1)!.id:null},document.grant.scope.planId);
}
