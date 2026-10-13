import { neon } from '@neondatabase/serverless';
import { nativeSigningIdentity } from './isolated-native-budget.js';
import { verifyRaydium22Landed, verifyRaydium22SignedMessage } from './native-copy-review.js';
import type { Token22SigningRequest } from './token2022-signing.js';
import type { Rpc } from './funding.js';
import { recoverSignedFromFinalizedBlock } from './copy-block-recovery.js';
import { MAINNET_GENESIS } from './solana-network.js';
export type NativePending = {
    id: string;
    hash: string;
    signature: string;
    signed: string;
    evidence: {
        request: Token22SigningRequest;
        leaderSignature: string;
        createdAt?: number;
    };
};
function nativeEvidence(row: NativePending) {
    const e = row.evidence, r = e.request, at = e.createdAt ?? Math.max(r.review.reviewedAt, r.permission.scope.issuedAt);
    const i = nativeSigningIdentity(r, e.leaderSignature, at);
    if (i.hash !== row.hash || i.executionId !== row.id || verifyRaydium22SignedMessage(r.review, r.reviewHash, row.signed) !== row.signature)
        throw Error('Native private evidence changed.');
    return i;
}
export function nativeReceipt(row: NativePending, value: unknown) {
    const i = nativeEvidence(row), r = row.evidence.request;
    const receipt = verifyRaydium22Landed(r.review, r.reviewHash, { version: 1, reviewHash: r.reviewHash, signed: row.signed, signature: row.signature }, value);
    const spent = BigInt(receipt.feeLamports) + (receipt.kind === 'succeeded' ? BigInt(receipt.rentLamports) + (i.side === 'buy' ? BigInt(receipt.inputRaw) : 0n) : 0n);
    if (spent > BigInt(i.lamports))
        throw Error('Native spend exceeds its private reservation.');
    return { i, receipt, spent: spent.toString(), credit: receipt.kind === 'succeeded' && i.side === 'buy' ? receipt.outputRaw : '0' };
}
export function isolatedNativeInventory(url: string) {
    const client = () => neon(url, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
    const mapped = (rows: Record<string, any>[]): NativePending[] => rows.map(r => ({ id: r.execution_id, hash: r.request_hash, signature: r.signature, signed: r.signed_transaction, evidence: r.evidence }));
    return {
        async minimumSlot(wallet: string, mint: string) {
            const [row] = await client() `SELECT GREATEST(COALESCE((SELECT max(settled_slot) FROM signer_native_requests WHERE wallet=${wallet} AND mint=${mint}),0),COALESCE((SELECT max(slot) FROM signer_inventory_reviews WHERE wallet=${wallet} AND mint=${mint} AND lane='native' AND state='applied'),0))::text AS slot`;
            const slot = Number(row.slot);
            if (!Number.isSafeInteger(slot))
                throw Error('Invalid native inventory slot.');
            return slot;
        },
        async pending() { return mapped(await client() `SELECT execution_id,request_hash,signature,signed_transaction,evidence FROM signer_native_requests WHERE state='signed' AND unsigned_expired_at IS NULL AND settlement='pending' AND next_check_at<=clock_timestamp() ORDER BY next_check_at,execution_id LIMIT 8`); },
        async recent(wallet: string, mint: string) { return mapped(await client() `SELECT execution_id,request_hash,signature,signed_transaction,evidence FROM signer_native_requests WHERE wallet=${wallet} AND mint=${mint} AND state='signed' AND unsigned_expired_at IS NULL AND settlement='pending' ORDER BY created_at DESC,execution_id LIMIT 4`); },
        async defer(row: NativePending) { await client() `UPDATE signer_native_requests SET next_check_at=clock_timestamp()+interval '30 seconds' WHERE execution_id=${row.id} AND request_hash=${row.hash} AND settlement='pending'`; },
        async settle(row: NativePending, value: unknown) {
            const { i, receipt, spent, credit } = nativeReceipt(row, value), db = client();
            const [, , rows] = await db.transaction([
                db `SELECT pg_advisory_xact_lock(hashtextextended(${`native:${i.wallet}:${i.planId}`},0))`,
                db `SELECT pg_advisory_xact_lock(hashtextextended(${`native-inventory:${i.wallet}:${i.mint}`},0))`,
                db `UPDATE signer_native_requests SET settlement=${receipt.kind},credited_raw=${credit}::numeric,actual_lamports=${spent}::bigint,
     settled_slot=${receipt.slot},receipt=${JSON.stringify(receipt)}::jsonb,updated_at=clock_timestamp()
     WHERE execution_id=${i.executionId} AND request_hash=${i.hash} AND signed_transaction=${row.signed} AND unsigned_expired_at IS NULL AND settlement='pending' RETURNING execution_id`,
            ]);
            return rows.length === 1;
        },
    };
}
// The private service only reads finalized receipts. Missing/expired signatures
// cannot credit a holding or refund a daily budget reservation.
export async function recoverNativeInventory(store: ReturnType<typeof isolatedNativeInventory>, rpc: Rpc, signal: AbortSignal, target?: {
    wallet: string;
    mint: string;
}, blockRpc?: () => Rpc) {
    signal.throwIfAborted();
    const rows = target ? await store.recent(target.wallet, target.mint) : await store.pending();
    const report = { checked: 0, settled: 0, pending: 0, refused: 0 };
    if (!rows.length)
        return report;
    if (await rpc('getGenesisHash', []) !== MAINNET_GENESIS)
        throw Error('Native recovery requires mainnet.');
    let blockReads = 0;
    for (const row of rows) {
        signal.throwIfAborted();
        await store.defer(row);
        try {
            let value: unknown = null, primaryFailed = false;
            try {
                value = await rpc('getTransaction', [row.signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
            }
            catch {
                signal.throwIfAborted();
                primaryFailed = true;
            }
            signal.throwIfAborted();
            report.checked++;
            // Only missing/failed reads use archive recovery. Never replace a
            // malformed positive receipt, and keep signing-path reads bounded.
            if (value === null && blockRpc && !target && blockReads < 2) {
                blockReads++;
                nativeEvidence(row);
                const result = await recoverSignedFromFinalizedBlock({ signature: row.signature, signed: row.signed, minContextSlot: row.evidence.request.review.minContextSlot }, blockRpc());
                signal.throwIfAborted();
                value = result.reply;
                primaryFailed = false;
            }
            if (primaryFailed)
                throw Error('Receipt provider unavailable.');
            if (value === null) {
                report.pending++;
                continue;
            }
            if (await store.settle(row, value))
                report.settled++;
        }
        catch {
            signal.throwIfAborted();
            report.refused++;
        }
    }
    return report;
}
