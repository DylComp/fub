import { MAINNET_GENESIS } from './solana-network.js';
import { neon } from '@neondatabase/serverless';
import { verifyControlledExpiry } from './controlled-leader-expiry.js';
import { nativeSigningIdentity } from './isolated-native-budget.js';
import { verifyRaydium22SignedMessage } from './native-copy-review.js';
import { isolatedNativeInventory, type NativePending } from './isolated-native-inventory.js';
import type { Rpc } from './funding.js';
// Separate low-frequency recovery lane. No signer, transaction construction or
// send method is reachable. A failed/incomplete scan retains the reservation.
export async function recoverNativeExpiry(url:string,rpc:Rpc,signal:AbortSignal){
 const client=()=>neon(url,{fetchOptions:{signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])}});
 const db=client();
 const [r]=await db`WITH due AS (SELECT execution_id FROM signer_native_requests
 WHERE state='signed' AND settlement='pending' AND unsigned_expired_at IS NULL
 AND expires_at<clock_timestamp()-interval '2 minutes' AND expiry_next_check_at<=clock_timestamp()
 ORDER BY expiry_next_check_at,execution_id FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE signer_native_requests n SET expiry_next_check_at=clock_timestamp()+interval '5 minutes'
 FROM due WHERE n.execution_id=due.execution_id
 RETURNING n.execution_id,n.request_hash,n.signature,n.signed_transaction,n.evidence`;
 if(!r)return {outcome:'idle' as const};
 const row:NativePending={id:r.execution_id,hash:r.request_hash,signature:r.signature,signed:r.signed_transaction,evidence:r.evidence};
 const e=row.evidence,request=e.request,i=nativeSigningIdentity(request,e.leaderSignature,e.createdAt??Math.max(request.review.reviewedAt,request.permission.scope.issuedAt));
 if(i.executionId!==row.id||i.hash!==row.hash||verifyRaydium22SignedMessage(request.review,request.reviewHash,row.signed)!==row.signature)throw Error('Expiry identity changed.');
 let reads=0;
 const read:Rpc=async(method,params)=>{
  signal.throwIfAborted();
  if(!['getGenesisHash','getBlockHeight','getTransaction','getSlot','getBlocks','getBlock'].includes(method)||++reads>610)throw Error('Expiry read limit.');
  const value=await rpc(method,params);signal.throwIfAborted();return value;
 };
 if(await read('getGenesisHash',[])!==MAINNET_GENESIS)throw Error('Expiry requires mainnet.');
 const height=await read('getBlockHeight',[{commitment:'finalized'}]);
 if(!Number.isSafeInteger(height)||Number(height)<=request.review.lastValidBlockHeight)return {outcome:'pending' as const};
 const value=await read('getTransaction',[row.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
 if(value!==null){await isolatedNativeInventory(url).settle(row,value);return {outcome:'receipt' as const};}
 const proof=await verifyControlledExpiry(request.review,request.reviewHash,{version:1,reviewHash:request.reviewHash,signed:row.signed,signature:row.signature},read);
 signal.throwIfAborted();
 const sql=client();
 const [,,changed]=await sql.transaction([
 sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native:${i.wallet}:${i.planId}`},0))`,
 sql`SELECT pg_advisory_xact_lock(hashtextextended(${`native-inventory:${i.wallet}:${i.mint}`},0))`,
 sql`UPDATE signer_native_requests SET settlement='expired',actual_lamports=0,settled_slot=${proof.lastSlot},receipt=${JSON.stringify(proof)}::jsonb,updated_at=clock_timestamp()
 WHERE execution_id=${i.executionId} AND request_hash=${i.hash} AND state='signed' AND settlement='pending'
 AND signed_transaction=${row.signed} AND signature=${row.signature} AND evidence=${JSON.stringify(row.evidence)}::jsonb
 AND unsigned_expired_at IS NULL AND corrected_raw=0 RETURNING execution_id`,
 ]);
 return {outcome:changed.length?'expired' as const:'stale' as const};
}
