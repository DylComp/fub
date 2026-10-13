import {neon} from '@neondatabase/serverless';
// Private journal proof, not absence from an RPC index. Every opted-in request
// persists its signature before returning it. An unsigned expired row therefore
// cannot have delivered a transaction. The row update races signature persistence.
export async function recoverUnsignedSigning(url:string,signal:AbortSignal){
 signal.throwIfAborted();
 const db=neon(url,{fetchOptions:{signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])}});
 let expired=0;
 for(const [table,id] of [['signer_copy_requests','attempt_id'],['signer_copy_inventory','attempt_id'],['signer_native_requests','execution_id']] as const){
  signal.throwIfAborted();
  const rows=await db.query(`WITH due AS (SELECT ${id} FROM ${table}
   WHERE unsigned_recovery AND unsigned_expired_at IS NULL AND signed_transaction IS NULL AND expires_at<=clock_timestamp()
   AND state IN('requested','reserved','uncertain') ORDER BY expires_at,${id} LIMIT 8 FOR UPDATE SKIP LOCKED)
   UPDATE ${table} r SET unsigned_expired_at=clock_timestamp(),updated_at=clock_timestamp() FROM due
   WHERE r.${id}=due.${id} AND r.signed_transaction IS NULL AND r.unsigned_expired_at IS NULL RETURNING r.${id}`);
  expired+=rows.length;
 }
 return {expired};
}
