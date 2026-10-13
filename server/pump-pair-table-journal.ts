import {createHash,createPublicKey,verify,randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import bs58 from 'bs58';
import {neon} from '@neondatabase/serverless';
import {PublicKey} from '@solana/web3.js';
import {inspectPairTable,type PumpPairTablePlan} from '../src/pump-pair-table.js';
export type LaunchTableIntent={publicationId:string;owner:string;mint:string;quoteMint:string};
export type LaunchTableAttempt={id:string;intent:LaunchTableIntent;plan:PumpPairTablePlan;state:'prepared'|'pending'|'confirmed'|'failed'|'expired_unresolved';signed:string|null;signature:string|null;receipt:LaunchTableReceipt|null};
export type LaunchTableReceipt={slot:number;debitLamports:number;table:string;success:boolean};
export function tablePlanId(intent:LaunchTableIntent,plan:PumpPairTablePlan){
 if(!/^[a-f0-9]{64}$/.test(intent.publicationId)||![intent.owner,intent.mint,intent.quoteMint].every(a=>new PublicKey(a).toBase58()===a)||new Set([intent.owner,intent.mint,intent.quoteMint]).size!==3)throw Error('Invalid launch table intent.');
 if([intent.mint,intent.quoteMint].includes(plan.owner))throw Error('Invalid setup payer.');
 inspectPairTable(plan,plan.owner,intent.quoteMint,plan.rentLamports);
 return createHash('sha256').update(canonicalize({intent,plan})!).digest('hex');
}
export function verifyTableSigned(intent:LaunchTableIntent,plan:PumpPairTablePlan,signed:string){
 tablePlanId(intent,plan);const tx=inspectPairTable(plan,plan.owner,intent.quoteMint,plan.rentLamports,signed);
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),new PublicKey(plan.owner).toBuffer()]),format:'der',type:'spki'});
 if(!verify(null,tx.message.serialize(),key,tx.signatures[0]))throw Error('Invalid launch table signature.');
 return bs58.encode(tx.signatures[0]);
}
function parse(r:any):LaunchTableAttempt|null{
 if(!r)return null;const intent={publicationId:r.publication_id,owner:r.owner,mint:r.mint,quoteMint:r.quote_mint};
 if(tablePlanId(intent,r.plan)!==r.id||r.signed_transaction&&verifyTableSigned(intent,r.plan,r.signed_transaction)!==r.signature)throw Error('Stored launch table integrity mismatch.');
 return{id:r.id,intent,plan:r.plan,state:r.state,signed:r.signed_transaction,signature:r.signature,receipt:r.receipt};
}
export function launchTableStore(url:string){
 const db=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(8000)}});
 return{
  async save(intent:LaunchTableIntent,plan:PumpPairTablePlan){
   const id=tablePlanId(intent,plan),sql=db();
   await sql`INSERT INTO fomo_launch_pair_tables(id,publication_id,owner,mint,quote_mint,plan)
    SELECT ${id},p.id,p.owner,${intent.mint},${intent.quoteMint},${JSON.stringify(plan)}::jsonb FROM fomo_launch_publications p
    WHERE p.id=${intent.publicationId} AND p.owner=${intent.owner} AND p.data->'draft'->>'quoteMint'=${intent.quoteMint}
    ON CONFLICT DO NOTHING`;
   const saved=await this.forPublication(intent.publicationId,intent.owner);
   if(!saved||saved.id!==id)throw Error('A launch table already exists for this publication. Recover it first.');return saved;
  },
  async refreshUnsigned(previous:LaunchTableAttempt,plan:PumpPairTablePlan,proof:{blockHeight:number;slot:number}){
   if(previous.state!=='prepared'||previous.signature||previous.signed||!Number.isSafeInteger(proof.blockHeight)||proof.blockHeight<=previous.plan.lastValidBlockHeight||!Number.isSafeInteger(proof.slot)||proof.slot<previous.plan.slot||plan.lastValidBlockHeight<=proof.blockHeight||plan.slot<proof.slot||plan.table===previous.plan.table)throw Error('Unsigned pair setup expiry proof required.');
   const id=tablePlanId(previous.intent,plan);
   const rows=await db()`UPDATE fomo_launch_pair_tables SET id=${id},plan=${JSON.stringify(plan)}::jsonb,
    unsigned_history=unsigned_history||${JSON.stringify([{id:previous.id,plan:previous.plan,proof}])}::jsonb
    WHERE id=${previous.id} AND owner=${previous.intent.owner} AND state='prepared' AND signature IS NULL AND signed_transaction IS NULL RETURNING *`;
   if(rows.length!==1)throw Error('Pair setup changed while refreshing.');return parse(rows[0])!;
  },
  async forPublication(id:string,owner:string){return parse((await db()`SELECT * FROM fomo_launch_pair_tables WHERE publication_id=${id} AND owner=${owner}`)[0]);},
  async get(id:string,owner:string){return parse((await db()`SELECT * FROM fomo_launch_pair_tables WHERE id=${id} AND owner=${owner}`)[0]);},
  async due(){return await db()`SELECT id,owner FROM fomo_launch_pair_tables WHERE state IN('pending','expired_unresolved')
   AND(checked_at IS NULL OR checked_at<clock_timestamp()-interval '60 seconds')
   AND(lease_until IS NULL OR lease_until<clock_timestamp()) ORDER BY checked_at NULLS FIRST,created_at LIMIT 10` as {id:string;owner:string}[];},
  async failedCheck(id:string,lease:string){await db()`UPDATE fomo_launch_pair_tables SET checked_at=clock_timestamp()
   WHERE id=${id} AND lease_id=${lease}::uuid AND lease_until>clock_timestamp() AND state IN('pending','expired_unresolved')`;},
  async bind(id:string,owner:string,signed:string){
   const p=await this.get(id,owner);if(!p)throw Error('Launch table not found.');
   if(p.plan.owner!==owner)throw Error('Sponsored setup uses the internal funding path.');
   const signature=verifyTableSigned(p.intent,p.plan,signed);
   await db()`UPDATE fomo_launch_pair_tables SET signed_transaction=${signed},signature=${signature},state='pending',signed_at=clock_timestamp() WHERE id=${id} AND owner=${owner} AND state='prepared' AND signed_transaction IS NULL`;
   const saved=await this.get(id,owner);if(!saved||saved.signature!==signature||saved.signed!==signed)throw Error('Another table signature is already saved.');return saved;
  },
  async bindSponsored(id:string,owner:string,signed:string,policy:{payer:string;maxSetupLamports:number;dailyCapLamports:number;perOwnerLimit:number}){
   if(!Number.isSafeInteger(policy.maxSetupLamports)||policy.maxSetupLamports<5000||policy.maxSetupLamports>5005000||!Number.isSafeInteger(policy.dailyCapLamports)||policy.dailyCapLamports<policy.maxSetupLamports||policy.dailyCapLamports>1000000000||!Number.isInteger(policy.perOwnerLimit)||policy.perOwnerLimit<1||policy.perOwnerLimit>100)throw Error('Invalid sponsorship budget.');
   const p=await this.get(id,owner);if(!p||p.plan.owner!==policy.payer||p.intent.owner===policy.payer)throw Error('Sponsored setup payer mismatch.');
   const debit=p.plan.rentLamports+p.plan.feeLamports;
   if(debit>policy.maxSetupLamports)throw Error('Pair setup exceeds sponsorship limit.');
   const signature=verifyTableSigned(p.intent,p.plan,signed),sql=db();
   if(p.signature){if(p.signature!==signature||p.signed!==signed)throw Error('Another table signature is saved.');return p;}
   const [,rows]=await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`launch-pair-sponsor:${policy.payer}`},0))`,
    sql`UPDATE fomo_launch_pair_tables SET signed_transaction=${signed},signature=${signature},state='pending',signed_at=clock_timestamp()
      WHERE id=${id} AND owner=${owner} AND state='prepared' AND signature IS NULL AND signed_transaction IS NULL AND plan->>'owner'=${policy.payer}
       AND COALESCE((SELECT sum((plan->>'rentLamports')::bigint+(plan->>'feeLamports')::bigint) FROM fomo_launch_pair_tables
         WHERE plan->>'owner'=${policy.payer} AND signature IS NOT NULL AND (signed_at>=clock_timestamp()-interval '24 hours' OR state IN('pending','expired_unresolved'))),0)+${debit}::bigint<=${policy.dailyCapLamports}::bigint
       AND (SELECT count(*) FROM fomo_launch_pair_tables WHERE owner=${owner} AND plan->>'owner'=${policy.payer} AND signature IS NOT NULL
         AND (signed_at>=clock_timestamp()-interval '24 hours' OR state IN('pending','expired_unresolved')))<${policy.perOwnerLimit} RETURNING id`,
   ]);
   const saved=await this.get(id,owner);
   if(saved?.signature===signature&&saved.signed===signed)return saved;
   if(!rows.length)throw Error('Automatic setup budget is full. Retry after its reserved attempts settle.');
   throw Error('Automatic setup changed while saving.');
  },
  async claim(id:string,owner:string){
   const lease=randomUUID(),rows=await db()`UPDATE fomo_launch_pair_tables SET lease_id=${lease}::uuid,lease_until=clock_timestamp()+interval '60 seconds'
    WHERE id=${id} AND owner=${owner} AND state IN('pending','expired_unresolved') AND(lease_until IS NULL OR lease_until<clock_timestamp()) RETURNING *`;
   const a=parse(rows[0]);return a?{attempt:a,lease}:null;
  },
  async maySend(id:string,lease:string){return(await db()`SELECT 1 FROM fomo_launch_pair_tables WHERE id=${id} AND lease_id=${lease}::uuid AND lease_until>clock_timestamp() AND state='pending'`).length===1;},
  async settle(id:string,lease:string,state:'pending'|'expired_unresolved'|'confirmed'|'failed',receipt?:LaunchTableReceipt){
   if(['confirmed','failed'].includes(state)!==!!receipt)throw Error('Finalized table evidence required.');
   if(receipt&&(!Number.isSafeInteger(receipt.slot)||receipt.slot<1||!Number.isSafeInteger(receipt.debitLamports)||receipt.debitLamports<5000||receipt.success!==(state==='confirmed')))throw Error('Invalid table receipt.');
   const rows=await db()`UPDATE fomo_launch_pair_tables SET state=${state},receipt=${receipt?JSON.stringify(receipt):null}::jsonb,checked_at=clock_timestamp()
    WHERE id=${id} AND lease_id=${lease}::uuid AND lease_until>clock_timestamp() AND state IN('pending','expired_unresolved')
     AND (${!receipt} OR(plan->>'table'=${receipt?.table??null} AND ${receipt?.debitLamports??0}::bigint=CASE WHEN ${receipt?.success??false} THEN (plan->>'rentLamports')::bigint+(plan->>'feeLamports')::bigint ELSE (plan->>'feeLamports')::bigint END)) RETURNING id`;
   if(rows.length!==1)throw Error('Launch table settlement lease lost.');
  },
  async release(id:string,lease:string){await db()`UPDATE fomo_launch_pair_tables SET lease_until=clock_timestamp() WHERE id=${id} AND lease_id=${lease}::uuid`;},
 };
}
