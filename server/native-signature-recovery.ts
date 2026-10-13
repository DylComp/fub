import {validateSignedNativeExpiry,type SignedNativeExpiry} from './native-expiry-proof.js';
import { neon } from '@neondatabase/serverless';
import canonicalize from 'canonicalize';
import { getTransactionDecoder, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { isMint } from '../src/assets.js';
import { operationId } from '../src/funding-model.js';
import { record } from '../src/live-orders.js';
import { nativeSigningIdentity, isolatedNativeBudget } from './isolated-native-budget.js';
import { verifyRaydium22SignedMessage } from './native-copy-review.js';
import { nativeReceipt, type NativePending } from './isolated-native-inventory.js';
import { token22Journal } from './token2022-journal.js';
import { MAINNET_GENESIS } from './solana-network.js';
import type { Rpc } from './funding.js';
export type NativeRecoveryRequest = {
    wallet: string;
    executionId: string;
    claimId: string;
    reviewHash: string;
    expiresAt: number;
};
export type UnsignedNativeExpiry = {status:'unsigned-expired';wallet:string;executionId:string;claimId:string;reviewHash:string};
export type NativeSignatureRecovery = (request: NativeRecoveryRequest, signal: AbortSignal) => Promise<string | UnsignedNativeExpiry | SignedNativeExpiry | null>;
export function validateUnsignedNativeExpiry(value:UnsignedNativeExpiry,r:NativeRecoveryRequest){
 if(!value||Object.keys(value).sort().join(',')!=='claimId,executionId,reviewHash,status,wallet'||value.status!=='unsigned-expired'||value.wallet!==r.wallet||value.executionId!==r.executionId||value.claimId!==r.claimId||value.reviewHash!==r.reviewHash)throw Error('Unsigned recovery proof changed.');
 return value;
}
export function validateNativeRecoveryRequest(r: NativeRecoveryRequest) {
    if (!r || Object.keys(r).sort().join(',') !== 'claimId,executionId,expiresAt,reviewHash,wallet' || !isMint(r.wallet) || !operationId(r.executionId) || !operationId(r.claimId) || !(/^[a-f0-9]{64}$/.test(r.reviewHash)) || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= Date.now() || r.expiresAt > Date.now() + 30000)
        throw Error('Native recovery request refused.');
}
// Historical signatures can be released after pause/revocation only if finalized
// or no longer executable. This endpoint never asks the provider to sign again.
export async function releaseNativeSignature(row: NativePending, rpc: Rpc, signal: AbortSignal): Promise<string | null> {
    const e = row.evidence, r = e.request, i = nativeSigningIdentity(r, e.leaderSignature, e.createdAt ?? Math.max(r.review.reviewedAt, r.permission.scope.issuedAt));
    if (row.id !== i.executionId || row.hash !== i.hash || verifyRaydium22SignedMessage(r.review, r.reviewHash, row.signed) !== row.signature)
        throw Error('Native recovery evidence changed.');
    const read = async (method: string, params: any[]) => { signal.throwIfAborted(); const value = await rpc(method, params); signal.throwIfAborted(); return value; };
    if (await read('getGenesisHash', []) !== MAINNET_GENESIS)
        throw Error('Recovery requires mainnet.');
    const value = await read('getTransaction', [row.signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
    if (value !== null) {
        nativeReceipt(row, value);
        return row.signed;
    }
    const tx = getTransactionDecoder().decode(Buffer.from(row.signed, 'base64')), m = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const valid = record(await read('isBlockhashValid', [m.lifetimeToken, { commitment: 'finalized', minContextSlot: r.review.minContextSlot }])), slot = record(valid.context).slot;
    if (valid.value !== false || !Number.isSafeInteger(slot) || (slot as number) < r.review.minContextSlot)
        return null;
    const height = await read('getBlockHeight', [{ commitment: 'finalized', minContextSlot: slot }]);
    if (!Number.isSafeInteger(height) || (height as number) <= r.review.lastValidBlockHeight)
        return null;
    return row.signed;
}
export function nativeSignatureRecovery(config: {
    applicationReadUrl: string;
    privateBudgetUrl: string;
    rpc: Rpc;
}): NativeSignatureRecovery {
    return async (r, signal) => {
        validateNativeRecoveryRequest(r);
        signal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(8000, r.expiresAt - Date.now()))]);
        const options = { fetchOptions: { signal } }, source = neon(config.applicationReadUrl, options), privateDb = neon(config.privateBudgetUrl, options);
        const [app] = await source `SELECT review,state FROM fomo_token22_executions WHERE id=${r.executionId} AND wallet=${r.wallet} AND review_hash=${r.reviewHash} AND signing_claim=${r.claimId} AND state IN('signing','signed','confirmed','failed')`;
        if (!app)
            throw Error('Recovery claim changed.');
        let [saved] = await privateDb `SELECT execution_id,request_hash,signature,signed_transaction,evidence,unsigned_expired_at,unsigned_recovery,settlement,receipt FROM signer_native_requests WHERE execution_id=${r.executionId} AND wallet=${r.wallet} AND (state='signed' OR unsigned_expired_at IS NOT NULL)`;
        if (!saved) {
            // Historical signed permission and exact journal identity survive
            // pause and expiry. This path cannot sign, refresh or submit a trade.
            const [expired] = await source`SELECT e.review,g.scope,g.signature,g.scope_hash,j.leader_signature
              FROM fomo_token22_executions e
              JOIN fomo_token22_jobs j ON j.id=e.queue_job_id AND j.execution_id=e.id AND j.wallet=e.wallet
              JOIN fomo_token22_permissions g ON g.id=j.permission_id AND g.wallet=e.wallet AND g.plan_id=j.plan_id
              WHERE e.id=${r.executionId} AND e.wallet=${r.wallet} AND e.signing_claim=${r.claimId}
                AND e.review_hash=${r.reviewHash} AND e.state='signing'
                AND e.signature IS NULL AND e.signed_transaction IS NULL
                AND e.expires_at<=clock_timestamp()`;
            if (expired) {
                const request={wallet:r.wallet,executionId:r.executionId,claimId:r.claimId,
                    idempotencyKey:`${r.executionId}:${r.reviewHash}`,review:expired.review,reviewHash:r.reviewHash,
                    expiresAt:expired.review.expiresAt,permission:{scope:expired.scope,signature:expired.signature,scopeHash:expired.scope_hash}};
                await isolatedNativeBudget(config.privateBudgetUrl).fenceUnadmitted(request,expired.leader_signature);
                signal.throwIfAborted();
                [saved] = await privateDb`SELECT execution_id,request_hash,signature,signed_transaction,evidence,unsigned_expired_at,unsigned_recovery,settlement,receipt
                  FROM signer_native_requests WHERE execution_id=${r.executionId} AND wallet=${r.wallet} AND (state='signed' OR unsigned_expired_at IS NOT NULL)`;
            }
        }
        if (!saved)
            return null;
        const e = saved.evidence as NativePending['evidence'];
        if (e.request.claimId !== r.claimId || e.request.reviewHash !== r.reviewHash || canonicalize(e.request.review) !== canonicalize(app.review))
            throw Error('Native recovery review changed.');
        const identity=nativeSigningIdentity(e.request,e.leaderSignature,e.createdAt ?? Math.max(e.request.review.reviewedAt,e.request.permission.scope.issuedAt));
        if(identity.hash!==saved.request_hash||identity.executionId!==r.executionId)throw Error('Recovery identity changed.');
        if(saved.unsigned_expired_at){
            const at=new Date(saved.unsigned_expired_at).getTime();
            if(saved.unsigned_recovery!==true||!Number.isSafeInteger(at)||at<identity.expiresAt||at>Date.now())throw Error('Unsigned recovery proof is invalid.');
            return {status:'unsigned-expired',wallet:r.wallet,executionId:r.executionId,claimId:r.claimId,reviewHash:r.reviewHash};
        }
        if(saved.settlement==='expired'){
            if(verifyRaydium22SignedMessage(e.request.review,e.request.reviewHash,saved.signed_transaction)!==saved.signature)throw Error('Expired signature changed.');
            if(app.state==='signing')return saved.signed_transaction;
            return validateSignedNativeExpiry({status:'signed-expired',wallet:r.wallet,executionId:r.executionId,claimId:r.claimId,reviewHash:r.reviewHash,signature:saved.signature,proof:saved.receipt},r,app.review,saved.signature);
        }
        return releaseNativeSignature({ id: saved.execution_id, hash: saved.request_hash, signature: saved.signature, signed: saved.signed_transaction, evidence: e }, config.rpc, signal);
    };
}
// Recover one application journal handoff per pass. Advance its due time before
// network I/O so an unknown request cannot starve the rest after a process exit.
export async function recoverNativeHandoff(url: string, recover: NativeSignatureRecovery, signal: AbortSignal) {
    signal.throwIfAborted();
    const db = neon(url, { fetchOptions: { signal } });
    const rows = await db `WITH candidate AS (SELECT id FROM fomo_token22_executions WHERE signed_expiry IS NULL AND signing_claim IS NOT NULL AND ((state='signing' AND next_check_at<=clock_timestamp()) OR (state='signed' AND handoff_next_check_at<=clock_timestamp())) ORDER BY handoff_next_check_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
  UPDATE fomo_token22_executions e SET handoff_next_check_at=clock_timestamp()+interval '30 seconds',next_check_at=CASE WHEN e.state='signing' THEN clock_timestamp()+interval '30 seconds' ELSE e.next_check_at END FROM candidate c WHERE e.id=c.id RETURNING e.id,e.wallet,e.signing_claim,e.review_hash`;
    if (!rows.length)
        return false;
    const row = rows[0];
    const request={ executionId: row.id, wallet: row.wallet, claimId: row.signing_claim, reviewHash: row.review_hash, expiresAt: Date.now() + 8000 };
    const signed = await recover(request, signal);
    signal.throwIfAborted();
    if(signed && typeof signed==='object' && signed.status==='signed-expired'){
        const saved=await token22Journal(url).get(row.wallet,row.id);
        if(!saved?.execution)return true;
        validateSignedNativeExpiry(signed,request,saved.review,saved.execution.signature);
        await db`UPDATE fomo_token22_executions SET signed_expiry=${JSON.stringify(signed)}::jsonb,lease_id=NULL,lease_until=NULL,last_checked_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE id=${row.id} AND wallet=${row.wallet} AND signing_claim=${row.signing_claim} AND review_hash=${row.review_hash}
          AND state='signed' AND signed_expiry IS NULL AND signature=${saved.execution.signature} AND signed_transaction=${saved.execution.signed}`;
    }else if(signed && typeof signed==='object'){
        validateUnsignedNativeExpiry(signed,request);
        // Clearing the active claim is permitted only with the exact persisted
        // private proof. Its original claim ID remains in unsigned_expiry.
        await db`UPDATE fomo_token22_executions SET state='canceled',signing_claim=NULL,unsigned_expiry=${JSON.stringify(signed)}::jsonb,updated_at=clock_timestamp()
          WHERE id=${row.id} AND wallet=${row.wallet} AND signing_claim=${row.signing_claim} AND review_hash=${row.review_hash}
          AND state='signing' AND signature IS NULL AND signed_transaction IS NULL AND expires_at<=clock_timestamp()`;
    }else if (signed)await token22Journal(url).saveSigned(row.wallet, row.id, row.signing_claim, signed);
    return true;
}
