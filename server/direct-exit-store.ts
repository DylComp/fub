import { neon } from '@neondatabase/serverless';
import type { DirectExitTerms, ExitWatermark, ExitLeg, ExitObservation } from '../src/direct-exits.js';
import type { DirectExitOutcome } from './direct-exit-settlement.js';
import type { DirectExitReview } from './direct-exit-native.js';
export type DirectExitRecord = {
  terms: DirectExitTerms; termsHash: string; signature: string; userId: string;
  state: 'watching'|'signing'|'signed'|'submitted'|'confirmed'|'failed'|'cancelled'|'expired'|'uncertain';
  revision: number; watermark: ExitWatermark; attemptId: string|null; leg: ExitLeg|null;
  review: DirectExitReview|null; signed: string|null; transactionSignature: string|null;
  observationClaim?: string|null;
  trigger?: ExitObservation|null; outcome?: DirectExitOutcome|null; deliveryId?: string|null; deliveryUntil?: number|null;
};
function record(r: Record<string,any>): DirectExitRecord {
  return {terms:r.terms,termsHash:r.terms_hash,signature:r.signature,userId:r.user_id,state:r.state,revision:r.revision,
    watermark:{highRaw:r.high_raw===null?null:String(r.high_raw),slot:Number(r.observed_slot),checkedAt:Number(r.observed_at)},
    attemptId:r.attempt_id,leg:r.leg,review:r.review,signed:r.signed_transaction,transactionSignature:r.transaction_signature,
    observationClaim:r.observation_claim??null,
    trigger:r.trigger_observation??null,outcome:r.outcome??null,deliveryId:r.delivery_id??null,deliveryUntil:r.delivery_until?new Date(r.delivery_until).getTime():null};
}
export function directExitStore(url: string) {
  const sql=()=>neon(url,{fetchOptions:{signal:AbortSignal.timeout(5000)}});
  return {
    async create(t:DirectExitTerms,termsHash:string,signature:string,userId:string) {
      const rows=await sql()`INSERT INTO signer_direct_exits(id,wallet,mint,user_id,terms,terms_hash,signature,expires_at)
        VALUES(${t.id},${t.wallet},${t.mint},${userId},${JSON.stringify(t)}::jsonb,${termsHash},${signature},to_timestamp(${t.expiresAt}/1000.0))
        ON CONFLICT(id) DO NOTHING RETURNING id`;
      if(!rows.length){const r=await this.get(t.id);if(!r||r.termsHash!==termsHash||r.signature!==signature||r.userId!==userId)throw Error('Exit identity already used.');}
    },
    async expireApproval(t:DirectExitTerms,termsHash:string,signature:string,userId:string){
      // Fence a never-recorded approval after admission closes. A concurrent
      // activation competes for this same primary key; neither can overwrite
      // the other's state, and create() never revives an expired row.
      await sql()`INSERT INTO signer_direct_exits(id,wallet,mint,user_id,terms,terms_hash,signature,expires_at,state)
        SELECT ${t.id},${t.wallet},${t.mint},${userId},${JSON.stringify(t)}::jsonb,${termsHash},${signature},to_timestamp(${t.expiresAt}/1000.0),'expired'
        WHERE LEAST(${t.issuedAt}::bigint+300000,${t.expiresAt}::bigint) <= extract(epoch FROM clock_timestamp())*1000
        ON CONFLICT(id) DO NOTHING`;
      return this.get(t.id);
    },
    async get(id:string):Promise<DirectExitRecord|null>{const r=await sql()`SELECT * FROM signer_direct_exits WHERE id=${id}`;return r[0]?record(r[0]):null;},
    async watching(limit=10):Promise<DirectExitRecord[]>{
      if(!Number.isInteger(limit)||limit<1||limit>25)throw Error('Invalid batch size.');
      await sql()`UPDATE signer_direct_exits SET state='expired',revision=revision+1,updated_at=clock_timestamp() WHERE state='watching' AND expires_at<=clock_timestamp()`;
      return (await sql()`WITH due AS (SELECT id FROM signer_direct_exits WHERE state='watching' AND expires_at>clock_timestamp()
        AND next_observe_at<=clock_timestamp() AND (observation_until IS NULL OR observation_until<=clock_timestamp())
        ORDER BY next_observe_at,id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
        UPDATE signer_direct_exits e SET next_observe_at=clock_timestamp()+interval '5 seconds',
        observation_claim=gen_random_uuid(),observation_until=clock_timestamp()+interval '30 seconds'
        FROM due WHERE e.id=due.id RETURNING e.*`).map(record);
    },
    async releaseObservation(r:DirectExitRecord){
      if(!r.observationClaim)throw Error('Observation lease is missing.');
      await sql()`UPDATE signer_direct_exits SET observation_claim=NULL,observation_until=NULL,next_observe_at=clock_timestamp()+interval '5 seconds'
        WHERE id=${r.terms.id} AND observation_claim=${r.observationClaim}`;
    },
    async observationQueue(){
      const [r]=await sql()`SELECT count(*)::int AS watching,
        count(*) FILTER (WHERE observation_until>statement_timestamp())::int AS leased,
        count(*) FILTER (WHERE next_observe_at<=statement_timestamp() AND (observation_until IS NULL OR observation_until<=statement_timestamp()))::int AS due,
        COALESCE(max(GREATEST(0,extract(epoch FROM (statement_timestamp()-next_observe_at))*1000))
          FILTER (WHERE observation_until IS NULL OR observation_until<=statement_timestamp()),0)::float8 AS oldest_due_ms
        FROM signer_direct_exits WHERE state='watching' AND expires_at>statement_timestamp()`;
      return {watching:Number(r.watching),leased:Number(r.leased),due:Number(r.due),oldestDueMs:Math.floor(Number(r.oldest_due_ms))};
    },
    async list(wallet:string,userId:string):Promise<DirectExitRecord[]>{return (await sql()`SELECT * FROM signer_direct_exits WHERE wallet=${wallet} AND user_id=${userId} ORDER BY created_at DESC LIMIT 100`).map(record);},
    async observe(r:DirectExitRecord,watermark:ExitWatermark):Promise<boolean>{
      const rows=await sql()`UPDATE signer_direct_exits SET high_raw=${watermark.highRaw},observed_slot=${watermark.slot},observed_at=${watermark.checkedAt},revision=revision+1,updated_at=clock_timestamp()
        WHERE id=${r.terms.id} AND terms_hash=${r.termsHash} AND revision=${r.revision} AND state='watching' AND expires_at>clock_timestamp()
        AND observed_slot<=${watermark.slot} AND observed_at<${watermark.checkedAt} AND (high_raw IS NULL OR high_raw<=${watermark.highRaw}::numeric) RETURNING id`;
      return rows.length===1;
    },
    async claim(r:DirectExitRecord,watermark:ExitWatermark,leg:ExitLeg,attemptId:string,review:DirectExitReview,trigger:ExitObservation):Promise<boolean>{
      const rows=await sql()`UPDATE signer_direct_exits SET state='signing',high_raw=${watermark.highRaw},observed_slot=${watermark.slot},observed_at=${watermark.checkedAt},revision=revision+1,
        attempt_id=${attemptId},leg=${leg},review=${JSON.stringify(review)}::jsonb,trigger_observation=${JSON.stringify(trigger)}::jsonb,updated_at=clock_timestamp()
        WHERE id=${r.terms.id} AND terms_hash=${r.termsHash} AND revision=${r.revision} AND state='watching' AND expires_at>clock_timestamp()
        AND observed_slot<=${watermark.slot} AND observed_at<${watermark.checkedAt} AND (high_raw IS NULL OR high_raw<=${watermark.highRaw}::numeric) RETURNING id`;
      return rows.length===1;
    },
    async recordSigned(id:string,attemptId:string,signed:string,signature:string){
      const rows=await sql()`UPDATE signer_direct_exits SET state=CASE WHEN state='expired' THEN 'expired' ELSE 'signed' END,signed_transaction=${signed},transaction_signature=${signature},updated_at=clock_timestamp()
        WHERE id=${id} AND attempt_id=${attemptId} AND (state IN ('signing','uncertain') OR (state='expired' AND delivery_id IS NULL)) AND signed_transaction IS NULL RETURNING id`;
      if(rows.length!==1){const r=await this.get(id);if(r?.attemptId!==attemptId||r.signed!==signed||r.transactionSignature!==signature)throw Error('Exit signature persistence failed.');}
    },
    async uncertain(id:string,attemptId:string){await sql()`UPDATE signer_direct_exits SET state='uncertain',updated_at=clock_timestamp() WHERE id=${id} AND attempt_id=${attemptId} AND state='signing'`;},
    async expireUndelivered(r:DirectExitRecord):Promise<boolean>{
      // Only the private signer holds these bytes. The sign-only provider cannot
      // broadcast, and no executor has ever claimed them. Expiry must race the
      // delivery claim in the database, not be inferred from a stale snapshot.
      const rows=await sql()`UPDATE signer_direct_exits SET state='expired',revision=revision+1,updated_at=clock_timestamp()
        WHERE id=${r.terms.id} AND terms_hash=${r.termsHash} AND attempt_id=${r.attemptId}
        AND state IN ('signing','uncertain','signed') AND delivery_id IS NULL AND signed_transaction IS NOT DISTINCT FROM ${r.signed} AND transaction_signature IS NOT DISTINCT FROM ${r.transactionSignature}
        AND ((review->'intent'->>'expiresAt')::bigint <= extract(epoch from clock_timestamp())*1000 OR expires_at<=clock_timestamp()) RETURNING id`;
      return rows.length===1;
    },
    async deliveries(limit=5):Promise<DirectExitRecord[]>{
      if(!Number.isInteger(limit)||limit<1||limit>25)throw Error('Invalid batch size.');
      return (await sql()`SELECT * FROM signer_direct_exits WHERE state IN ('signed','submitted') AND signed_transaction IS NOT NULL
        AND expires_at>clock_timestamp() AND (delivery_until IS NULL OR delivery_until<clock_timestamp())
        AND (review->'intent'->>'expiresAt')::bigint > extract(epoch from clock_timestamp())*1000
        ORDER BY updated_at,id LIMIT ${limit}`).map(record);
    },
    async claimDelivery(r:DirectExitRecord,deliveryId:string,until:number):Promise<boolean>{
      if(!Number.isSafeInteger(until)||until<=Date.now()||until>Date.now()+10000||!r.review||until>r.terms.expiresAt||until>r.review.intent.expiresAt)throw Error('Invalid delivery window.');
      const rows=await sql()`UPDATE signer_direct_exits SET state='submitted',delivery_id=${deliveryId},delivery_until=to_timestamp(${until}/1000.0),updated_at=clock_timestamp()
        WHERE id=${r.terms.id} AND terms_hash=${r.termsHash} AND attempt_id=${r.attemptId} AND state IN ('signed','submitted')
        AND signed_transaction=${r.signed} AND transaction_signature=${r.transactionSignature} AND expires_at>clock_timestamp()
        AND to_timestamp(${until}/1000.0)>clock_timestamp() AND (delivery_until IS NULL OR delivery_until<clock_timestamp()) RETURNING id`;
      return rows.length===1;
    },
    async recoveryBatch(limit=5):Promise<DirectExitRecord[]>{
      if(!Number.isInteger(limit)||limit<1||limit>25)throw Error('Invalid batch size.');
      // Advance the due time before RPC work. A missing receipt cannot starve other orders.
      return (await sql()`WITH due AS (SELECT id FROM signer_direct_exits WHERE state IN ('signing','signed','submitted','uncertain')
        AND next_check_at<=clock_timestamp() ORDER BY next_check_at,id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
        UPDATE signer_direct_exits e SET next_check_at=clock_timestamp()+interval '15 seconds' FROM due WHERE e.id=due.id RETURNING e.*`).map(record);
    },
    async settle(r:DirectExitRecord,outcome:DirectExitOutcome):Promise<void>{
      if(outcome.signature!==r.transactionSignature||!r.review||outcome.messageHash!==r.review.messageHash)throw Error('Settlement identity changed.');
      const state=outcome.kind==='succeeded'?'confirmed':'failed';
      const rows=await sql()`UPDATE signer_direct_exits SET state=${state},outcome=${JSON.stringify(outcome)}::jsonb,updated_at=clock_timestamp()
        WHERE id=${r.terms.id} AND attempt_id=${r.attemptId} AND signed_transaction=${r.signed} AND transaction_signature=${r.transactionSignature}
        AND terms_hash=${r.termsHash} AND state IN ('signed','submitted','uncertain') RETURNING id`;
      if(!rows.length){const current=await this.get(r.terms.id);if(current?.state!==state||current.transactionSignature!==outcome.signature||JSON.stringify(current.outcome)!==JSON.stringify(outcome)){
        // JSONB key order is not stable. Retry equality is checked by the database.
        const same=await sql()`SELECT id FROM signer_direct_exits WHERE id=${r.terms.id} AND state=${state} AND outcome=${JSON.stringify(outcome)}::jsonb`;
        if(same.length!==1)throw Error('Exit settlement was not recorded.');
      }}
    },
    async cancel(id:string,userId:string):Promise<boolean>{
      const rows=await sql()`UPDATE signer_direct_exits SET state='cancelled',revision=revision+1,updated_at=clock_timestamp() WHERE id=${id} AND user_id=${userId} AND state='watching' RETURNING id`;
      if(rows.length)return true;const r=await this.get(id);return !!r&&r.userId===userId&&r.state==='cancelled';
    },
  };
}
export type DirectExitStore = ReturnType<typeof directExitStore>;
