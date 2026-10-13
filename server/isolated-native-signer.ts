import {NATIVE_COPY_MAX_SELL_RAW} from './native-copy-review.js';
import {assertNativePilotRequest,type NativePilotPolicy} from './native-pilot-policy.js';
import {NATIVE_SIGNING_TIMEOUT_MS} from './native-signing-deadline.js';
import { neon } from '@neondatabase/serverless';
import canonicalize from 'canonicalize';
import type { Token22Signer, Token22SigningRequest } from './token2022-signing.js';
import { nativeSigningIdentity, isolatedNativeBudget } from './isolated-native-budget.js';
import { rebuildNativeReview } from './isolated-native-review.js';
import { classifyLeaderSwap } from './copy-classifier.js';
import { MAINNET_GENESIS } from './solana-network.js';
import { TOKEN_2022 } from './jupiter-routes.js';
import { WSOL } from '../src/funding-model.js';
import { isolatedNativeInventory, recoverNativeInventory } from './isolated-native-inventory.js';
import { readNativeInventory } from './native-inventory.js';
import type { Rpc } from './funding.js';
import type { EnrolledWallet } from './signer-enrollment.js';
import type { PrivySignRequest } from './privy-sign-only.js';
export function nativeSigningSource(url: string) {
    return async (r: Token22SigningRequest) => {
        const db = neon(url, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
        const rows = await db `SELECT j.leader_signature,j.leader_slot,g.scope,g.signature,g.scope_hash,e.review,e.review_hash
   FROM fomo_token22_authorized_reservations a
   JOIN fomo_token22_executions e ON e.id=a.execution_id AND e.wallet=a.wallet
   JOIN fomo_token22_permissions g ON g.id=a.permission_id
   JOIN fomo_token22_current_jobs j ON j.id=e.queue_job_id AND j.execution_id=e.id
   WHERE e.id=${r.executionId} AND e.wallet=${r.wallet} AND e.state='signing' AND e.signing_claim=${r.claimId}
    AND e.signature IS NULL AND e.signed_transaction IS NULL AND e.expires_at>clock_timestamp()
    AND j.state='prepared' AND j.lease_id IS NOT NULL AND j.lease_until>clock_timestamp()
    AND j.leader_signature=a.leader_signature AND j.plan_id=a.plan_id AND j.permission_id=a.permission_id`;
        const row = rows[0];
        if (!row || row.scope_hash !== r.permission.scopeHash || row.signature !== r.permission.signature || row.review_hash !== r.reviewHash ||
            canonicalize(row.scope) !== canonicalize(r.permission.scope) || canonicalize(row.review) !== canonicalize(r.review))
            throw Error('Native permission or dispatch is no longer current.');
        return { leaderSignature: row.leader_signature as string, leaderSlot: Number(row.leader_slot) };
    };
}
// Dependencies are composed only inside the private host, never from HTTP data.
export function nativeSigningGate(options: {
    pilot?: NativePilotPolicy;
    source: ReturnType<typeof nativeSigningSource>;
    budget: Pick<ReturnType<typeof isolatedNativeBudget>, 'claim' | 'complete' | 'uncertain'>;
    diagnostic?: (event: {executionId:string; stage:string; elapsedMs:number; aborted:boolean; reviewReason?:'price-limit'|'blockhash'|'message-changed'|'rent-limit'}) => void;
    inventory?: ReturnType<typeof isolatedNativeInventory>;
    rpc: Rpc;
    resolveWallet: (wallet: string, issuedAt: number, signal: AbortSignal) => Promise<EnrolledWallet>;
    provider: (r: PrivySignRequest, signal: AbortSignal) => Promise<string>;
}): Token22Signer {
    return async (request, signal) => {
        const r = structuredClone(request), createdAt = Date.now();
        let stage = 'request';
        try {
        if (!Number.isSafeInteger(r.expiresAt) || r.expiresAt <= createdAt || r.expiresAt > createdAt + 60000)
            throw Error('Native signing deadline refused.');
        signal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(NATIVE_SIGNING_TIMEOUT_MS, r.expiresAt - createdAt))]);
        const active = () => { signal.throwIfAborted(); if (Date.now() >= r.expiresAt)
            throw Error('Native review expired.'); };
        active();
        if(options.pilot) assertNativePilotRequest(options.pilot,r);
        stage = 'source';
        const state = await options.source(r);
        nativeSigningIdentity(r, state.leaderSignature, createdAt);
        const selling = r.review.accounts.direction === 'sell';
        if (selling && !options.inventory)
            throw Error('Independent native inventory is unavailable.');
        let calls = 0;
        const rpc: Rpc = async (method, params) => {
            active();
            if (++calls > 48 || !['getGenesisHash', 'getTransaction', 'getBlockHeight', 'getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getFeeForMessage', 'getMinimumBalanceForRentExemption', 'isBlockhashValid', 'getLatestBlockhash', 'getTokenAccountBalance', 'simulateTransaction'].includes(method))
                throw Error('Native signer RPC refused.');
            const value = await options.rpc(method, params);
            active();
            return value;
        };
        stage = 'leader';
        if (await rpc('getGenesisHash', []) !== MAINNET_GENESIS)
            throw Error('Native signer requires mainnet.');
        const receipt = await rpc('getTransaction', [state.leaderSignature, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 1 }]) as {
            slot?: number;
            blockTime?: number;
        } | null;
        const now = Math.floor(Date.now() / 1000);
        if (!receipt || !Number.isSafeInteger(receipt.slot) || receipt.slot !== state.leaderSlot || !Number.isSafeInteger(receipt.blockTime) || receipt.blockTime! > now + 1 || now - receipt.blockTime! > 60)
            throw Error('Native leader receipt is missing or stale.');
        const decision = classifyLeaderSwap(receipt, r.permission.scope.leader, { signature: state.leaderSignature, slot: receipt.slot!, blockTime: receipt.blockTime!, failed: false });
        if (decision.kind !== 'swap' || decision.side !== (selling ? 'sell' : 'buy') || decision.mint !== r.review.accounts.mint || decision.tokenDecimals !== r.review.accounts.decimals || decision.tokenProgram !== (r.review.accounts.tokenProgram??TOKEN_2022) || decision.quoteMint !== WSOL)
            throw Error('Leader receipt does not authorize this native trade.');
        stage = 'independent-review';
        const fresh = await rebuildNativeReview(r.review, r.reviewHash, rpc, NATIVE_COPY_MAX_SELL_RAW, r.permission.scope.slippageBps,r.permission.scope.buyLamports);
        if (BigInt(fresh.maximumSetupRentLamports) > BigInt(r.permission.scope.maxRentLamports))
            throw Error('Permission does not cover the transaction account-creation limit.');
        stage = 'owner';
        const owner = await options.resolveWallet(r.wallet, r.permission.scope.issuedAt, signal);
        const current = async () => { active(); if(options.pilot) assertNativePilotRequest(options.pilot,r); const s = await options.source(r); if (s.leaderSignature !== state.leaderSignature || s.leaderSlot !== state.leaderSlot)
            throw Error('Native leader changed.'); await owner.check(signal); active(); };
        // resolveWallet just verified the owner. For sells, recheck both owner
        // and source AFTER reading inventory, immediately before reserving it.
        if (!selling) await current();
        let sell: Parameters<typeof options.budget.claim>[2];
        if (selling) {
            stage = 'inventory';
            await recoverNativeInventory(options.inventory!, rpc, signal, { wallet: r.wallet, mint: r.review.accounts.mint });
            const slot = await options.inventory!.minimumSlot(r.wallet, r.review.accounts.mint);
            const holdings = await readNativeInventory(r.wallet, r.review.accounts.mint, rpc, Math.max(slot, r.review.minContextSlot),r.review.accounts.tokenProgram??TOKEN_2022);
            sell = { leader: decision, holdings };
            await current();
        }
        stage = 'budget';
        const claim = await options.budget.claim(r, state.leaderSignature, sell);
        let signed: string;
        if (claim.kind === 'signed')
            signed = claim.signed;
        else {
            try {
                stage = 'before-provider';
                await current();
                stage = 'provider';
                // The native review can remain valid for 60 seconds, while
                // the sign-only provider transport accepts at most 30. Narrow
                // its request lifetime without extending the signed review.
                signed = await options.provider({ walletId: owner.walletId, wallet: r.wallet, unsigned: r.review.unsigned, idempotencyKey: r.idempotencyKey, expiresAt: Math.min(r.expiresAt, Date.now() + 30000) }, signal);
                // Preserve valid signed bytes even when access is stopped during provider work.
                stage = 'persistence';
                await options.budget.complete(r, state.leaderSignature, signed, createdAt);
            }
            catch {
                await options.budget.uncertain(r, state.leaderSignature, createdAt).catch(() => { });
                throw Error('Native signing is unresolved. Its budget remains reserved.');
            }
        }
        stage = 'delivery';
        await current();
        return signed;
        } catch (error) {
            // Fixed stage names only. Never log permission signatures, provider
            // responses, transaction bytes, keys or exception text.
            if (/^[a-f0-9-]{36}$/.test(r.executionId)) {
                const reasons:Record<string,'price-limit'|'blockhash'|'message-changed'|'rent-limit'>={
                    'Native minimum exceeds the allowed slippage from current simulated output.':'price-limit',
                    'Native blockhash is no longer valid.':'blockhash',
                    'Native transaction changed during independent review.':'message-changed',
                    'Permission does not cover the transaction account-creation limit.':'rent-limit',
                };
                const reviewReason=stage==='independent-review'&&error instanceof Error?reasons[error.message]:undefined;
                try { options.diagnostic?.({executionId:r.executionId,stage,elapsedMs:Date.now()-createdAt,aborted:signal.aborted,...(reviewReason?{reviewReason}:{})}); } catch { /* Telemetry cannot change signing outcomes. */ }
            }
            throw error;
        }
    };
}
export function isolatedNativeSigner(options: {
    pilot?: NativePilotPolicy;
    applicationReadUrl: string;
    privateBudgetUrl: string;
    rpc: Rpc;
    resolveWallet: (wallet: string, issuedAt: number, signal: AbortSignal) => Promise<EnrolledWallet>;
    provider: (r: PrivySignRequest, signal: AbortSignal) => Promise<string>;
}): Token22Signer {
    const a = new URL(options.applicationReadUrl), b = new URL(options.privateBudgetUrl);
    if (![a, b].every(u => ['postgres:', 'postgresql:'].includes(u.protocol)) || (a.hostname === b.hostname && a.pathname === b.pathname) || a.username === b.username)
        throw Error('Native signing requires separate databases and roles.');
    return nativeSigningGate({ ...options, diagnostic:event=>console.warn(JSON.stringify({event:'native-signing-refused',...event})), source: nativeSigningSource(options.applicationReadUrl), budget: isolatedNativeBudget(options.privateBudgetUrl,options.pilot), inventory: isolatedNativeInventory(options.privateBudgetUrl) });
}
