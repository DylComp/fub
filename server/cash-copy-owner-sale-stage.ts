import {randomUUID} from 'node:crypto';
import {compareCashCopyEvents,proportionalCashSale,validateCashCopyEvent,type CashCopyEvent} from '../src/cash-copy-model.js';
import type {CashCopyCas,CashCopyDocument} from './cash-copy-journal.js';
import type {CashCopyJob} from './cash-copy-service.js';
import type {CashSale} from './cash-return-store.js';
/** Private repair preparation only. A paused plan stays paused. No signing,
 * broadcasting, inventory debit or budget reset occurs. The owner must review
 * and sign through the normal recovery endpoint before anything can execute. */
export async function stageCashOwnerSale(c:{cas:CashCopyCas;planId:string;wallet:string;buyId:string;transaction:string;verify:(input:{network:CashCopyEvent['network'];leader:string;token:string;transaction:string})=>Promise<{event:CashCopyEvent}|null>;prepare:(j:CashCopyJob)=>Promise<CashSale>;now?:()=>number}){
 const row=await c.cas.read(c.planId,c.wallet);if(!row||!row.value.revoked)throw Error('Pause the plan before preparing owner recovery.');
 const d=row.value,buy=d.jobs[c.buyId],scope=d.grant.scope;
 if(!buy||buy.event.side!=='buy'||buy.state!=='complete'||buy.leaderInvalidatedAt||buy.scope.id!==scope.id||scope.sourceWallet!==c.wallet||!buy.purchase?.receipt?.finalized)throw Error('A finalized purchase in this permission is required.');
 const prior=Object.values(d.jobs).find(j=>j.event.network===buy.event.network&&j.event.transaction===c.transaction);
 if(prior)throw Error('Use the existing sale record.');
 if(Object.values(d.jobs).some(j=>!['complete','stopped'].includes(j.state)))throw Error('Resolve pending trades first.');
 // Closed jobs from older permissions remain audit history. They do not
 // create another lot in this permission; exact current inventory and the
 // global pending-job check above still prevent overlapping recovery.
 const key=buy.event.network+':'+buy.event.token,position=d.positions[key];
 if(position!==buy.purchase.receipt.receivedRaw||Object.values(d.jobs).some(j=>j.id!==buy.id&&j.scope.id===scope.id&&j.event.network===buy.event.network&&j.event.token===buy.event.token&&j.state!=='stopped'))throw Error('Recovery needs an isolated purchased position.');
 const proof=await c.verify({network:buy.event.network,leader:scope.leader,token:buy.event.token,transaction:c.transaction});
 const now=(c.now||Date.now)();
 if(!proof||proof.event.confirmation!=='finalized'||proof.event.side!=='sell'||proof.event.network!==buy.event.network||proof.event.token!==buy.event.token||proof.event.transaction!==c.transaction||compareCashCopyEvents(buy.event,proof.event)>=0)throw Error('Finalized leader sale not verified.');
 validateCashCopyEvent(proof.event,scope,now);
 const amountRaw=proportionalCashSale(position,proof.event),id=randomUUID();
 const job:CashCopyDocument['jobs'][string]={id,scope:structuredClone(scope),event:structuredClone(proof.event),amountRaw,state:'needs-attention',purchase:null,sale:null,signed:null,day:new Date(now).toISOString().slice(0,10)};
 const sale=await c.prepare(job),i=sale.simulation.route.intent;
 if(sale.id!==id||sale.wallet!==c.wallet||sale.state!=='prepared'||sale.signed||sale.hashes||sale.receipt||sale.feeWei||i.network!==job.event.network||i.token!==job.event.token||i.wallet!==scope.recipient||i.cashWallet!==c.wallet||i.amountRaw!==amountRaw||i.slippageBps!==scope.slippageBps||sale.gas.maxCostWei!==scope.maxSaleGas[i.network])throw Error('Unsigned recovery changed its scope.');
 const next=structuredClone(d) as CashCopyDocument&{execution:{sales:Record<string,CashSale>}};job.sale=sale;next.jobs[id]=job;next.execution.sales[id]=sale;
 if(!await c.cas.write(c.planId,c.wallet,row.revision,next))throw Error('Recovery changed during preparation.');
 return{id,amountRaw,minimumRaw:sale.simulation.route.minimumRaw,maxGasWei:sale.gas.maxCostWei};
}
