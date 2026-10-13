import canonicalize from 'canonicalize';
import {cashSigningDigest,cashSigningPartId,type CashSigningParts} from './cash-copy-signing-parts.js';
import type {CashCopyCas,CashCopyDocument} from './cash-copy-journal.js';
import type {CashCopyJob} from './cash-copy-service.js';
import {saleHashes,type CashSale} from './cash-return-store.js';
const same=(a:unknown,b:unknown)=>canonicalize(a)===canonicalize(b);
type Document=CashCopyDocument&{execution?:{sales:Record<string,CashSale>}};
export type OwnerSale={retired:CashSale;preparedAt:number};
/** Owner-signed recovery only. Never invokes a delegated signer or broadcasts.
 * The retired automatic attempt is fenced before a new review is saved. The
 * original grant, spending, inventory and signing history remain unchanged. */
export function cashCopyOwnerSale(c:{cas:CashCopyCas;parts:CashSigningParts;authorize:(token:string,planId:string,wallet:string,signal:AbortSignal)=>Promise<void>;prepare:(job:CashCopyJob)=>Promise<CashSale>;recheck:(sale:CashSale,job:CashCopyJob)=>Promise<void>;now?:()=>number}){
 const now=c.now||Date.now;
 async function read(planId:string,wallet:string,id:string){
  const row=await c.cas.read(planId,wallet),d=row?.value as Document|undefined,j=d?.jobs[id],s=d?.execution?.sales[id];
  if(!row||!d||!j||!s||j.event.side!=='sell'||j.scope.sourceWallet!==wallet||j.purchase||j.leaderInvalidatedAt||j.provisionalDebit||j.provisionalCredit)throw Error('This copied position cannot be recovered here.');
  if(!j.ownerSale&&(!d.revoked&&now()<j.scope.expiresAt||j.state!=='needs-attention'||j.signed||s.signed||s.hashes||s.receipt||s.feeWei||!same(j.sale,s)))throw Error('Resolve the existing automatic sale first.');
  if(BigInt(d.positions[j.event.network+':'+j.event.token]||'0')<BigInt(j.amountRaw))throw Error('Copied inventory changed.');
  if(Object.values(d.jobs).some(b=>b.id!==id&&b.event.network===j.event.network&&!['complete','stopped'].includes(b.state)))throw Error('Another trade on this network is unresolved.');
  return{row,d,j,s};
 }
 function matches(j:CashCopyJob,s:CashSale){const i=s.simulation.route.intent;
  // Retain the original prepared worst-case budget across every refresh.
  // Public admission changes cannot discard a stricter engineering ceiling.
  const cost=(v:CashSale)=>v.gas.transactions.reduce((n,t)=>n+BigInt(t.value)+BigInt(t.gas)*BigInt(t.maxFeePerGas),BigInt(v.gas.maxL1FeeWei||'0'));
  const retired=j.ownerSale?.retired||j.sale;if(!retired||cost(s)>cost(retired))throw Error('Recovery exceeds its original prepared gas budget.');
  if(s.id!==j.id||s.wallet!==j.scope.sourceWallet||i.cashWallet!==j.scope.sourceWallet||i.wallet!==j.scope.recipient||i.network!==j.event.network||i.token!==j.event.token||i.amountRaw!==j.amountRaw||i.slippageBps!==j.scope.slippageBps||s.gas.maxCostWei!==j.scope.maxSaleGas[j.event.network])throw Error('Recovery sale changed its limits.');
 }
 return{
  async review(token:string,planId:string,wallet:string,id:string,signal:AbortSignal){
   await c.authorize(token,planId,wallet,signal);
   const {row,d,j,s}=await read(planId,wallet,id);if(s.signed)return s;
   if(!j.ownerSale){
    const digest=cashSigningDigest({purpose:'owner-sale-recovery',job:j,sale:s});
    for(const index of [0,1]){signal.throwIfAborted();const key=cashSigningPartId(j,index);await c.parts.claim(key,digest);const part=await c.parts.get(key);if(!part||part.digest!==digest||part.state!=='claimed'||part.signed)throw Error('Automatic signing is unresolved.');}
   }
   const fresh=await c.prepare(j);matches(j,fresh);
   if(fresh.state!=='prepared'||fresh.signed||fresh.hashes||fresh.receipt||fresh.feeWei)throw Error('Recovery review is not unsigned.');
   // Once shown to a wallet, earlier bytes might have been signed locally.
   // Preserve the nonce pair so old and refreshed sales cannot both execute.
   if(j.ownerSale&&(fresh.gas.transactions.length!==s.gas.transactions.length||fresh.gas.transactions.some((tx,index)=>tx.nonce!==s.gas.transactions[index].nonce)||!same(fresh.simulation.route.approval,s.simulation.route.approval)))throw Error('Check the existing sale before refreshing.');
   signal.throwIfAborted();await c.authorize(token,planId,wallet,signal);
   const next=structuredClone(d),job=next.jobs[id];job.ownerSale??={retired:structuredClone(s),preparedAt:now()};job.sale=fresh;next.execution!.sales[id]=fresh;
   if(!await c.cas.write(planId,wallet,row.revision,next))throw Error('Recovery changed. Refresh the existing sale.');return fresh;
  },
  async submit(token:string,planId:string,wallet:string,id:string,signed:string[],signal:AbortSignal){
   await c.authorize(token,planId,wallet,signal);const {row,d,j,s}=await read(planId,wallet,id);
   if(!j.ownerSale)throw Error('Review the recovery sale first.');matches(j,s);
   const hashes=await saleHashes(s,signed);
   if(s.signed){if(!same(s.signed,signed)||!same(s.hashes,hashes))throw Error('Different sale signatures are recorded.');return s;}
   await c.recheck(s,j);signal.throwIfAborted();await c.authorize(token,planId,wallet,signal);
   const next=structuredClone(d),bound={...s,signed,hashes,state:'submitted' as const};next.execution!.sales[id]=bound;
   next.jobs[id].sale=bound;next.jobs[id].signed=signed;next.jobs[id].state='submitted';
   if(!await c.cas.write(planId,wallet,row.revision,next))throw Error('Recovery changed. Check the existing sale.');return bound;
  }
 };
}
