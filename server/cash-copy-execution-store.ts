import canonicalize from 'canonicalize';
import type {CashCopyCas,CashCopyDocument} from './cash-copy-journal.js';
import type {CashPurchase,CashPurchaseStore} from './cash-purchase-store.js';
import {saleHashes,type CashSale,type CashReturnStore} from './cash-return-store.js';
import {inspectSignedCashDeposit} from './cash-deposit.js';
const same=(a:unknown,b:unknown)=>canonicalize(a)===canonicalize(b);
type Execution={purchases:Record<string,CashPurchase>;sales:Record<string,CashSale>};
type Document=CashCopyDocument&{execution?:Execution};
/** Store execution records in the same private CAS document as the grant and
 * budget. The signer needs no write access to the public application's DB.
 * Backups carry reviews, signed bytes and recovery state together. */
export function cashCopyExecutionStores(cas:CashCopyCas,planId:string,wallet:string){
 async function read(){const row=await cas.read(planId,wallet);if(!row)throw Error('Copy journal missing.');return row.value as Document;}
 async function change<T>(fn:(d:Document,e:Execution)=>Promise<T>|T):Promise<T>{
  for(let attempt=0;attempt<12;attempt++){
   const row=await cas.read(planId,wallet);if(!row)throw Error('Copy journal missing.');
   const d=structuredClone(row.value) as Document;d.execution??={purchases:{},sales:{}};const result=await fn(d,d.execution);
   if(same(d,row.value)||await cas.write(planId,wallet,row.revision,d))return structuredClone(result);
  }throw Error('Copy execution journal is busy.');
 }
 const owner=(given:string)=>{if(given!==wallet)throw Error('Copy execution owner changed.');};
 const job=(d:Document,id:string,side:'buy'|'sell')=>{const j=d.jobs[id];if(!j||j.event.side!==side||j.scope.sourceWallet!==wallet)throw Error('Copy reservation missing.');return j;};
 const limit=(n:number)=>{if(!Number.isInteger(n)||n<1||n>100)throw Error('Invalid recovery limit.');return n;};
 const purchases:CashPurchaseStore={
  async get(id,given){owner(given);return structuredClone((await read()).execution?.purchases[id]||null);},
  async reserve(id,review,binding){return change((d,e)=>{
   const j=job(d,id,'buy'),s=j.scope,i=review.intent;
   if(d.revoked||i.sourceWallet!==wallet||i.recipient!==s.recipient||i.network!==j.event.network||i.token!==j.event.token||i.amountRaw!==j.amountRaw||i.slippageBps!==s.slippageBps||i.gasTopupUsdcRaw!==s.gasTopupUsdcRaw||review.admission!==undefined||binding.sourceWallet!==wallet||binding.recipient!==s.recipient||binding.network!==i.network)throw Error('Copy purchase differs from its reservation.');
   const old=e.purchases[id];if(old){if(!same(old.review,review)||!same(old.binding,binding))throw Error('Copy purchase already exists.');return old;}
   if(j.state!=='reserved')throw Error('Copy preparation already passed.');
   return e.purchases[id]={id,wallet,review:structuredClone(review),binding:structuredClone(binding),state:'prepared',signed:null,signature:null,receipt:null};
  });},
  async refresh(){throw Error('An automatic copy review is immutable. Resolve the existing attempt.');},
  async bind(id,given,signed){owner(given);return change((d,e)=>{job(d,id,'buy');const p=e.purchases[id];if(!p)throw Error('Copy purchase missing.');const signature=inspectSignedCashDeposit(p.review,signed);
   if(p.signed){if(p.signed!==signed||p.signature!==signature)throw Error('Copy purchase signature changed.');return p;}
   if(p.state!=='prepared')throw Error('Copy purchase is no longer prepared.');p.signed=signed;p.signature=signature;p.state='submitted';return p;
  });},
  async expire(id,given,blockhash){owner(given);return change((_,e)=>{const p=e.purchases[id];if(!p)throw Error('Copy purchase missing.');if(p.state==='prepared'&&!p.signed&&p.review.blockhash===blockhash)p.state='expired';return p;});},
  async expireUnlanded(previous,checkedAt){owner(previous.wallet);return change((_,e)=>{const p=e.purchases[previous.id];if(!p)throw Error('Copy purchase missing.');if(!same(p,previous))return p;
   if(p.state!=='submitted'||!p.signed||!p.signature||p.receipt||!Number.isSafeInteger(checkedAt))throw Error('Invalid unlanded copy expiry.');
   p.review={...p.review,unlandedSubmission:{signed:p.signed,signature:p.signature,checkedAt,evidence:'expired-blockhash-and-finalized-source-history'}} as typeof p.review;p.state='expired';p.signed=null;p.signature=null;return p;
  });},
  async settle(id,signature,state,receipt){return change((_,e)=>{const p=e.purchases[id];if(!p||p.signature!==signature)throw Error('Copy purchase signature missing.');
   if((state==='complete'||state==='refunded')!==!!receipt||receipt&&receipt.requestId!==p.review.quote.requestId)throw Error('Copy purchase receipt changed.');
   if(['submitted','settling','delayed','needs-attention'].includes(p.state)){p.state=state;p.receipt=receipt?structuredClone(receipt):null;}return p;
  });},
  async pending(n){return structuredClone(Object.values((await read()).execution?.purchases||{}).filter(p=>['prepared','submitted','settling','delayed','needs-attention'].includes(p.state)).slice(0,limit(n)));},
 };
 const sales:CashReturnStore={
  async get(id,given){owner(given);return structuredClone((await read()).execution?.sales[id]||null);},
  async reserve(id,simulation,gas){return change((d,e)=>{const j=job(d,id,'sell'),s=j.scope,i=simulation.route.intent;
   if(d.revoked||i.cashWallet!==wallet||i.wallet!==s.recipient||i.network!==j.event.network||i.token!==j.event.token||i.amountRaw!==j.amountRaw||i.slippageBps!==s.slippageBps||gas.maxCostWei!==s.maxSaleGas[i.network])throw Error('Copy sale differs from its reservation.');
   const old=e.sales[id];if(old){if(!same(old.simulation,simulation)||!same(old.gas,gas))throw Error('Copy sale already exists.');return old;}
   if(j.state!=='reserved')throw Error('Copy preparation already passed.');
   return e.sales[id]={id,wallet,simulation:structuredClone(simulation),gas:structuredClone(gas),state:'prepared',signed:null,hashes:null,receipt:null,feeWei:null};
  });},
  async refresh(){throw Error('An automatic copy review is immutable. Resolve the existing attempt.');},
  async bind(id,given,signed){owner(given);return change(async(d,e)=>{job(d,id,'sell');const p=e.sales[id];if(!p)throw Error('Copy sale missing.');const hashes=await saleHashes(p,signed);
   if(p.signed){if(!same(p.signed,signed)||!same(p.hashes,hashes))throw Error('Copy sale signature changed.');return p;}
   if(p.state!=='prepared')throw Error('Copy sale is no longer prepared.');p.signed=structuredClone(signed);p.hashes=hashes;p.state='submitted';return p;
  });},
  async settle(id,given,state,feeWei,receipt){owner(given);return change((_,e)=>{const p=e.sales[id];if(!p)throw Error('Copy sale missing.');
   if(['prepared','expired','submitted'].includes(state)||feeWei!==undefined&&!/^(0|[1-9]\d{0,77})$/.test(feeWei))throw Error('Invalid copy sale settlement.');
   if((state==='complete'||state==='refunded')!==!!receipt||receipt&&receipt.requestId!==p.simulation.route.requestId)throw Error('Copy sale receipt changed.');
   if(['submitted','settling','delayed','needs-attention'].includes(p.state)){p.state=state;if(feeWei!==undefined)p.feeWei=feeWei;p.receipt=receipt?structuredClone(receipt):null;}return p;
  });},
  async pending(n){return structuredClone(Object.values((await read()).execution?.sales||{}).filter(p=>['prepared','submitted','settling','delayed','needs-attention'].includes(p.state)).slice(0,limit(n)));},
 };
 return{purchases,sales};
}
