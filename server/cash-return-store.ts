import {CASH_NETWORKS,isCashNetwork} from '../src/cash-route.js';
import canonicalize from 'canonicalize';
import {neon} from '@neondatabase/serverless';
import {inspectSignedCashEvm,type CashReturnGas,type CashReturnSimulation} from './cash-return-transaction.js';
import type {CashReceipt} from '../src/cash-recovery.js';
export type CashSaleState='prepared'|'expired'|'submitted'|'settling'|'delayed'|'needs-attention'|'complete'|'refunded'|'reverted';
export type CashSale={id:string;wallet:string;simulation:CashReturnSimulation;gas:CashReturnGas;state:CashSaleState;signed:string[]|null;hashes:string[]|null;receipt:CashReceipt|null;feeWei:string|null};
export interface CashReturnStore{
 get(id:string,wallet:string):Promise<CashSale|null>;
 reserve(id:string,simulation:CashReturnSimulation,gas:CashReturnGas):Promise<CashSale>;
 refresh(previous:CashSale,simulation:CashReturnSimulation,gas:CashReturnGas):Promise<CashSale>;
 bind(id:string,wallet:string,signed:string[]):Promise<CashSale>;
 settle(id:string,wallet:string,state:CashSaleState,feeWei?:string,receipt?:CashReceipt):Promise<CashSale>;
 pending(limit:number):Promise<CashSale[]>;
}
export async function saleHashes(sale:Pick<CashSale,'gas'>,signed:string[]){
 if(!Array.isArray(signed)||signed.length!==sale.gas.transactions.length||signed.length<1||signed.length>2)throw Error('All sale signatures are required.');
 return Promise.all(signed.map((value,i)=>inspectSignedCashEvm(sale.gas.transactions[i],value)));
}
function parse(r:any):CashSale|null{
 if(!r)return null;
 const sale:CashSale={id:r.id,wallet:r.wallet,simulation:r.simulation,gas:r.gas,state:r.state,signed:r.signed_transactions,hashes:r.hashes,feeWei:r.fee_wei,receipt:r.receipt};
 const network=sale.simulation.route.intent.network;
 if(!isCashNetwork(network)||!sale.gas.transactions.every(tx=>tx.chainId===CASH_NETWORKS[network].chainId))throw Error('Sale network journal integrity failed.');
 if(sale.wallet!==sale.simulation.route.intent.cashWallet||r.request_id!==sale.simulation.route.requestId||r.evm_wallet!==sale.simulation.route.intent.wallet||!!sale.signed!==!!sale.hashes)throw Error('Sale journal integrity failed.');
 return sale;
}
export function cashReturnStore(url:string):CashReturnStore{
 const query=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(10000)}});
 return {
  async get(id,wallet){const sql=query();return parse((await sql`SELECT * FROM fub_cash_sales WHERE id=${id}::uuid AND wallet=${wallet}`)[0]);},
  async reserve(id,simulation,gas){const sql=query(),route=simulation.route;
   await sql`INSERT INTO fub_cash_sales(id,wallet,evm_wallet,request_id,simulation,gas) VALUES(${id}::uuid,${route.intent.cashWallet},${route.intent.wallet},${route.requestId},${JSON.stringify(simulation)}::jsonb,${JSON.stringify(gas)}::jsonb) ON CONFLICT DO NOTHING`;
   const saved=await this.get(id,route.intent.cashWallet);
   if(!saved||canonicalize(saved.simulation)!==canonicalize(simulation)||canonicalize(saved.gas)!==canonicalize(gas))throw Error('Another sale is unresolved. Check its status.');
   return saved;
  },
  async refresh(previous,simulation,gas){
   if(previous.state!=='prepared'||previous.signed||previous.hashes)throw Error('A signed sale cannot be replaced.');
   if(canonicalize(previous.simulation.route.intent)!==canonicalize(simulation.route.intent)||gas.maxCostWei!==previous.gas.maxCostWei||
     gas.transactions.length!==previous.gas.transactions.length||gas.transactions.some((tx,i)=>tx.nonce!==previous.gas.transactions[i].nonce))throw Error('Sale refresh changed its reserved limits.');
   const {supersededReviews:history=[],...oldSimulation}=previous.simulation as CashReturnSimulation&{supersededReviews?:unknown[]};
   if(!Array.isArray(history)||history.length>=8)throw Error('This sale needs review before another quote.');
   const next={...simulation,supersededReviews:[...history,{simulation:oldSimulation,gas:previous.gas}]};
   const sql=query();
   await sql`UPDATE fub_cash_sales SET request_id=${simulation.route.requestId},simulation=${JSON.stringify(next)}::jsonb,gas=${JSON.stringify(gas)}::jsonb,updated_at=clock_timestamp()
    WHERE id=${previous.id}::uuid AND wallet=${previous.wallet} AND state='prepared' AND signed_transactions IS NULL AND hashes IS NULL
    AND request_id=${previous.simulation.route.requestId} AND gas=${JSON.stringify(previous.gas)}::jsonb`;
   const saved=await this.get(previous.id,previous.wallet);
   if(!saved||saved.simulation.route.requestId!==simulation.route.requestId||canonicalize(saved.gas)!==canonicalize(gas))throw Error('The sale changed while refreshing. Check its status.');
   return saved;
  },
  async bind(id,wallet,signed){const saved=await this.get(id,wallet);if(!saved)throw Error('Sale not found.');const hashes=await saleHashes(saved,signed),sql=query();
   await sql`UPDATE fub_cash_sales SET signed_transactions=${JSON.stringify(signed)}::jsonb,hashes=${JSON.stringify(hashes)}::jsonb,state='submitted',updated_at=clock_timestamp() WHERE id=${id}::uuid AND wallet=${wallet} AND state='prepared' AND signed_transactions IS NULL AND request_id=${saved.simulation.route.requestId} AND gas=${JSON.stringify(saved.gas)}::jsonb`;
   const next=await this.get(id,wallet);if(!next||JSON.stringify(next.signed)!==JSON.stringify(signed))throw Error('A different sale submission is recorded.');return next;
  },
  async settle(id,wallet,state,feeWei,receipt){const sql=query();if(['prepared','expired','submitted'].includes(state)||((state==='complete'||state==='refunded')!==!!receipt))throw Error('Invalid sale settlement.');
   await sql`UPDATE fub_cash_sales SET state=${state},fee_wei=COALESCE(${feeWei||null},fee_wei),receipt=${receipt?JSON.stringify(receipt):null}::jsonb,updated_at=clock_timestamp() WHERE id=${id}::uuid AND wallet=${wallet} AND state IN('submitted','settling','delayed','needs-attention')`;
   const next=await this.get(id,wallet);if(!next)throw Error('Sale not found.');return next;
  },
  async pending(limit){if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid sale recovery batch.');const sql=query();return (await sql`SELECT * FROM fub_cash_sales WHERE state IN('submitted','settling','delayed','needs-attention') ORDER BY updated_at LIMIT ${limit}`).map(row=>parse(row)!);}
 };
}
