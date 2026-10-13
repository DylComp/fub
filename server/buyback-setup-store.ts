import {neon} from '@neondatabase/serverless';
import type {BuybackSetupReview} from '../src/buyback-setup.js';
import {BUYBACK_SETUP,verifySignedBuybackSetup} from '../src/buyback-setup.js';
import bs58 from 'bs58';
// One fixed infrastructure operation. Signed packets are retained before any
// broadcast; only a finalized receipt or a full nonlanding proof closes one.
export function buybackSetupStore(url = process.env.DATABASE_URL!) {
  const db=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(8000)}});
  return {
    async pending() {
      const sql=db();const rows=await sql`SELECT signature FROM fomo_buyback_setup_attempts WHERE state='pending' ORDER BY created_at LIMIT 1`;
      return rows[0]?.signature as string|undefined;
    },
    async save(signature:string,review:BuybackSetupReview,signed:string) {
      const tx=await verifySignedBuybackSetup(review,signed);
      if(bs58.encode(tx.signatures[0])!==signature)throw Error('Setup signature mismatch.');
      const sql=db();
      const [,rows]=await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(344004)`,
        sql`INSERT INTO fomo_buyback_setup_attempts(signature,review,signed_transaction)
          SELECT ${signature},${JSON.stringify(review)}::jsonb,${signed}
          WHERE NOT EXISTS(SELECT 1 FROM fomo_buyback_setup_attempts WHERE state IN ('pending','confirmed') AND signature<>${signature})
            AND COALESCE((SELECT sum(debit_lamports) FROM fomo_buyback_setup_attempts),0)+${review.debit}<=${BUYBACK_SETUP.cap}
          ON CONFLICT(signature) DO UPDATE SET signature=EXCLUDED.signature
            WHERE fomo_buyback_setup_attempts.signed_transaction=EXCLUDED.signed_transaction AND fomo_buyback_setup_attempts.state='pending'
          RETURNING signature`,
      ]);
      if(rows.length!==1)throw Error('A previous account setup must be resolved before another is sent.');
    },
    async settle(signature:string,debit:number,success:boolean,slot:number) {
      if(!Number.isSafeInteger(debit)||debit<5000||debit>BUYBACK_SETUP.cap||!Number.isSafeInteger(slot)||slot<1)throw Error('Invalid setup receipt.');
      const sql=db();
      await sql`UPDATE fomo_buyback_setup_attempts SET state=${success?'confirmed':'failed'},debit_lamports=${debit},receipt=${JSON.stringify({slot,debit,success})}::jsonb,finalized_at=clock_timestamp() WHERE signature=${signature} AND state='pending'`;
    },
  };
}
