import canonicalize from 'canonicalize';
import {neon} from '@neondatabase/serverless';
import {cashPurchaseStore} from './cash-purchase-store.js';
import {cashReturnStore,type CashReturnStore} from './cash-return-store.js';

// Limit-only adapter, used in the isolated signer database. Never install this
// over public/manual purchases, where an unsigned review may be in a wallet.
export function cashLimitExecutionStores(url:string){
 const purchases=cashPurchaseStore(url),baseSales=cashReturnStore(url);
 const query=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(8000)}});
 const uuid=(id:string)=>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))throw Error('Invalid limit attempt.');};
 async function retireExpiredUnsigned(id:string){
  uuid(id);const sql=query();
  // Row lock fences a concurrent execution claim. A claimed signing part,
  // even without returned bytes, makes retirement impossible.
  const result=await sql.transaction([
   sql`SELECT id FROM signer_cash_limits WHERE id=${id}::uuid FOR UPDATE`,
   sql`UPDATE fub_cash_purchases p SET state='expired',updated_at=clock_timestamp()
    WHERE p.id=${id}::uuid AND p.state='prepared' AND p.signed_transaction IS NULL AND p.signature IS NULL
    AND (p.review->'quote'->>'expiresAt')::bigint<=extract(epoch FROM clock_timestamp())*1000
    AND EXISTS(SELECT 1 FROM signer_cash_limits l WHERE l.id=p.id AND l.document->>'state' IN('waiting','cancelled','expired') AND NOT(l.document ? 'signed'))
    AND NOT EXISTS(SELECT 1 FROM signer_cash_parts s WHERE s.id LIKE ${'cash-limit:'+id+':%'} ) RETURNING p.id`,
   sql`UPDATE fub_cash_sales p SET state='expired',updated_at=clock_timestamp()
    WHERE p.id=${id}::uuid AND p.state='prepared' AND p.signed_transactions IS NULL AND p.hashes IS NULL
    AND LEAST((p.simulation->>'expiresAt')::bigint,(p.gas->>'expiresAt')::bigint)<=extract(epoch FROM clock_timestamp())*1000
    AND EXISTS(SELECT 1 FROM signer_cash_limits l WHERE l.id=p.id AND l.document->>'state' IN('waiting','cancelled','expired') AND NOT(l.document ? 'signed'))
    AND NOT EXISTS(SELECT 1 FROM signer_cash_parts s WHERE s.id LIKE ${'cash-limit:'+id+':%'} ) RETURNING p.id`,
  ]);
  return result[1].length+result[2].length;
 }
 async function retireExpiredUnsignedBatch(){
  const sql=query();
  const rows=await sql`SELECT l.id FROM signer_cash_limits l
   WHERE l.document->>'state' IN('waiting','cancelled','expired') AND NOT(l.document ? 'signed')
   AND (EXISTS(SELECT 1 FROM fub_cash_purchases p WHERE p.id=l.id AND p.state='prepared' AND p.signed_transaction IS NULL AND p.signature IS NULL AND (p.review->'quote'->>'expiresAt')::bigint<=extract(epoch FROM clock_timestamp())*1000)
    OR EXISTS(SELECT 1 FROM fub_cash_sales p WHERE p.id=l.id AND p.state='prepared' AND p.signed_transactions IS NULL AND p.hashes IS NULL AND LEAST((p.simulation->>'expiresAt')::bigint,(p.gas->>'expiresAt')::bigint)<=extract(epoch FROM clock_timestamp())*1000))
   AND NOT EXISTS(SELECT 1 FROM signer_cash_parts s WHERE s.id LIKE ('cash-limit:'||l.id::text||':%'))
   ORDER BY l.updated_at LIMIT 25`;
  let retired=0;for(const row of rows)retired+=await retireExpiredUnsigned(String(row.id));return retired;
 }
 const sales:CashReturnStore={...baseSales,
  // The manual service's prepare method cannot replace an expired sale. The
  // private adapter admits a fresh review only after the retirement above.
  async get(id,wallet){const p=await baseSales.get(id,wallet);return p?.state==='expired'&&!p.signed&&!p.hashes?null:p;},
  async reserve(id,simulation,gas){
   const old=await baseSales.get(id,simulation.route.intent.cashWallet);
   if(!old)return baseSales.reserve(id,simulation,gas);
   if(old.state!=='expired'||old.signed||old.hashes)return baseSales.reserve(id,simulation,gas);
   if(canonicalize(old.simulation.route.intent)!==canonicalize(simulation.route.intent)||old.gas.maxCostWei!==gas.maxCostWei)throw Error('Limit sale intent changed.');
   const {supersededReviews:history=[],...previous}=old.simulation as typeof old.simulation&{supersededReviews?:unknown[]};
   if(!Array.isArray(history)||history.length>=64)throw Error('Limit sale needs review after repeated quote expiry.');
   const next={...simulation,supersededReviews:[...history,{simulation:previous,gas:old.gas,state:'expired',neverSigned:true}]};
   const sql=query();
   await sql.transaction([
    sql`SELECT id FROM signer_cash_limits WHERE id=${id}::uuid FOR UPDATE`,
    sql`UPDATE fub_cash_sales p SET request_id=${simulation.route.requestId},simulation=${JSON.stringify(next)}::jsonb,gas=${JSON.stringify(gas)}::jsonb,state='prepared',updated_at=clock_timestamp()
     WHERE p.id=${id}::uuid AND p.wallet=${old.wallet} AND p.state='expired' AND p.signed_transactions IS NULL AND p.hashes IS NULL
     AND p.simulation=${JSON.stringify(old.simulation)}::jsonb AND p.gas=${JSON.stringify(old.gas)}::jsonb
     AND EXISTS(SELECT 1 FROM signer_cash_limits l WHERE l.id=p.id AND l.document->>'state'='preparing' AND NOT(l.document ? 'signed'))
     AND NOT EXISTS(SELECT 1 FROM signer_cash_parts s WHERE s.id LIKE ${'cash-limit:'+id+':%'})`,
   ]);
   const saved=await baseSales.get(id,old.wallet);
   if(!saved||saved.state!=='prepared'||canonicalize(saved.simulation)!==canonicalize(next)||canonicalize(saved.gas)!==canonicalize(gas))throw Error('Limit sale changed before its unsigned refresh.');
   return saved;
  },
 };
 return{purchases,sales,retireExpiredUnsigned,retireExpiredUnsignedBatch};
}
