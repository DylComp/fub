import {assertNativePilotRequest,nativeSellWithoutSetup,parseNativePilotPolicy,validatePriorUnsignedExecutions,type NativePilotPolicy} from './native-pilot-policy.js';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { neon } from '@neondatabase/serverless';
import { operationId } from '../src/funding-model.js';
import { signatureValid } from './copy-classifier.js';
import { verifyToken22Permission, assertToken22PermissionReview } from './token2022-permission.js';
import { verifyRaydium22Review, verifyRaydium22SignedMessage } from './native-copy-review.js';
import { swapRaw } from '../src/copy-swap.js';
import type { SwapEvidence } from '../src/copy-feed.js';
import type { readToken22Inventory } from './token2022-inventory.js';
import type { Token22SigningRequest } from './token2022-signing.js';
import { isAddress } from '@solana/kit';

// A pilot permits one buy attempt for the lifetime of a plan, including unsigned
// attempts that later expire. This read-only check must precede a leader trade.
// It is advisory: claim() still enforces the same rule under its database locks.
export async function nativePilotStartReadiness(url: string, wallet: string, planId: string,
    prior?: {mint:string;executionIds:readonly string[];permissionHash?:string}) {
    if (!isAddress(wallet) || !operationId(planId)) throw Error('Invalid pilot identity.');
    const db = neon(url, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
    const ids=prior?validatePriorUnsignedExecutions(prior.executionIds):[];
    if(prior&&(!isAddress(prior.mint)||prior.permissionHash!==undefined&&!/^[a-f0-9]{64}$/.test(prior.permissionHash)))throw Error('Invalid pilot history scope.');
    const [row] = await db`SELECT count(*) FILTER(WHERE NOT execution_id=ANY(${ids}::uuid[]))::int AS attempts,
      count(*) FILTER(WHERE execution_id=ANY(${ids}::uuid[]) AND mint=${prior?.mint??''} AND unsigned_recovery AND unsigned_expired_at IS NOT NULL
        AND expires_at<=clock_timestamp() AND signature IS NULL AND signed_transaction IS NULL AND credited_raw=0 AND corrected_raw=0 AND actual_lamports IS NULL
        AND (${prior?.permissionHash??null}::text IS NULL OR permission_hash<>${prior?.permissionHash??null}))::int AS closed
      FROM signer_native_requests WHERE wallet=${wallet} AND plan_id=${planId}`;
    if (!row || !Number.isSafeInteger(row.attempts) || row.attempts < 0) throw Error('Pilot history unavailable.');
    return { ready: row.attempts === 0 && row.closed===ids.length, attempts: row.attempts as number,
        reason: row.closed!==ids.length?'prior_attempt_not_closed' as const:row.attempts === 0 ? null : 'plan_already_attempted' as const };
}
export function nativeSigningIdentity(r: Token22SigningRequest, leaderSignature: string, now = Date.now()) {
    const p = r.permission.scope;
    verifyRaydium22Review(r.review, r.reviewHash);
    assertToken22PermissionReview(p, r.review);
    if (verifyToken22Permission(p, r.permission.signature) !== r.permission.scopeHash || !operationId(r.executionId) || !operationId(r.claimId) || !signatureValid(leaderSignature) ||
        (r.review.accounts.direction === 'sell' && !p.copySells) || r.wallet !== p.wallet || r.idempotencyKey !== `${r.executionId}:${r.reviewHash}` ||
        !Number.isSafeInteger(now) || p.issuedAt > now || p.expiresAt <= now || r.review.reviewedAt > now ||
        !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= now || r.expiresAt > Math.min(p.expiresAt, r.review.expiresAt))
        throw Error('Independent native permission refused.');
    const day = new Date(now).toISOString().slice(0, 10);
    if (new Date(r.review.expiresAt).toISOString().slice(0, 10) !== day)
        throw Error('Native review crosses its spending day.');
    // Reserve the worst owner-approved input, fee and account rent. Existing ATA
    // accounts can disappear before execution; today's simulated cost is not a cap.
    const lamports = ((r.review.accounts.direction === 'buy' ? BigInt(p.buyLamports) : 0n) + BigInt(p.maxFeeLamports) + (nativeSellWithoutSetup(r.review) ? 0n : BigInt(p.maxRentLamports))).toString();
    const hash = createHash('sha256').update(canonicalize({ executionId: r.executionId, claimId: r.claimId, wallet: r.wallet, permissionHash: r.permission.scopeHash, reviewHash: r.reviewHash, leaderSignature })!).digest('hex');
    return { side: r.review.accounts.direction, mint: r.review.accounts.mint, decimals: r.review.accounts.decimals, inputRaw: r.review.accounts.inputRaw, executionId: r.executionId, wallet: r.wallet, planId: p.planId, leaderSignature, hash, permissionHash: r.permission.scopeHash, day, lamports, cap: p.dailySpendLamports, expiresAt: r.review.expiresAt };
}
export function isolatedNativeBudget(url: string, policy?: NativePilotPolicy) {
    const pilot=policy ? parseNativePilotPolicy(policy) : undefined;
    const priorIds=pilot?.priorUnsignedExecutions??[];
    const client = () => neon(url, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
    return {
        // A unique execution row is also a durable fence. Inserting this expired
        // row races the ordinary budget INSERT, so absence alone never authorizes
        // cancellation. An already admitted or signed request always wins intact.
        async fenceUnadmitted(r: Token22SigningRequest, leaderSignature: string) {
            const createdAt = Math.max(r.review.reviewedAt, r.permission.scope.issuedAt);
            const i = nativeSigningIdentity(r, leaderSignature, createdAt);
            if (i.expiresAt > Date.now()) return false;
            const rows = await client()`INSERT INTO signer_native_requests
              (execution_id,wallet,plan_id,leader_signature,request_hash,permission_hash,day,reserved_lamports,evidence,expires_at,state,unsigned_recovery,unsigned_expired_at)
              SELECT ${i.executionId},${i.wallet},${i.planId},${i.leaderSignature},${i.hash},${i.permissionHash},${i.day}::date,${i.lamports}::bigint,
                ${JSON.stringify({request:r,leaderSignature,createdAt,recoveryReason:'never-admitted'})}::jsonb,to_timestamp(${i.expiresAt}/1000.0),'uncertain',true,clock_timestamp()
              WHERE to_timestamp(${i.expiresAt}/1000.0)<=clock_timestamp()
              ON CONFLICT DO NOTHING RETURNING execution_id`;
            return rows.length === 1;
        },
        async claim(r: Token22SigningRequest, leaderSignature: string, sell?: {
            leader: SwapEvidence;
            holdings: Awaited<ReturnType<typeof readToken22Inventory>>;
        }) {
            const i = nativeSigningIdentity(r, leaderSignature), db = client();
            if(pilot) assertNativePilotRequest(pilot,r);
            if (i.side === 'sell') {
                if (!sell || sell.leader.kind !== 'swap' || sell.leader.side !== 'sell' || sell.leader.mint !== i.mint || sell.leader.tokenDecimals !== i.decimals ||
                    sell.holdings.wallet !== i.wallet || sell.holdings.mint !== i.mint || sell.holdings.decimals !== i.decimals || !sell.holdings.exists ||
                    !Number.isSafeInteger(sell.holdings.slot) || sell.holdings.slot < 1 || !Number.isSafeInteger(sell.holdings.fetchedAt) ||
                    sell.holdings.fetchedAt > Date.now() || Date.now() - sell.holdings.fetchedAt > 5000 || swapRaw(sell.leader.tokenRaw) > swapRaw(sell.leader.leaderTokenBeforeRaw))
                    throw Error('Native sell inventory evidence refused.');
                swapRaw(sell.holdings.rawAmount);
            }
            const [, , rows] = await db.transaction([
                db `SELECT pg_advisory_xact_lock(hashtextextended(${`native:${i.wallet}:${i.planId}`},0))`,
                db `SELECT pg_advisory_xact_lock(hashtextextended(${`native-inventory:${i.wallet}:${i.mint}`},0))`,
                db `INSERT INTO signer_native_requests(execution_id,wallet,plan_id,leader_signature,request_hash,permission_hash,day,reserved_lamports,evidence,expires_at,unsigned_recovery)
     SELECT ${i.executionId},${i.wallet},${i.planId},${i.leaderSignature},${i.hash},${i.permissionHash},${i.day}::date,${i.lamports}::bigint,${JSON.stringify({ request: r, leaderSignature, createdAt: Date.now() })}::jsonb,to_timestamp(${i.expiresAt}/1000.0),true
     WHERE (clock_timestamp() AT TIME ZONE 'UTC')::date=${i.day}::date AND to_timestamp(${i.expiresAt}/1000.0)>clock_timestamp()
      AND COALESCE((SELECT sum(COALESCE(actual_lamports,reserved_lamports)) FROM signer_native_requests WHERE wallet=${i.wallet} AND plan_id=${i.planId} AND day=${i.day}::date AND unsigned_expired_at IS NULL),0)+${i.lamports}::bigint<=${i.cap}::bigint
     AND (${!pilot} OR (
       to_timestamp(${pilot?.expiresAt ?? 0}/1000.0)>clock_timestamp()
       AND (SELECT count(*) FROM signer_native_requests WHERE wallet=${i.wallet} AND plan_id=${i.planId} AND mint=${i.mint}
         AND execution_id=ANY(${priorIds}::uuid[]) AND unsigned_recovery AND unsigned_expired_at IS NOT NULL AND expires_at<=clock_timestamp()
         AND signature IS NULL AND signed_transaction IS NULL AND credited_raw=0 AND corrected_raw=0 AND actual_lamports IS NULL
         AND permission_hash<>${i.permissionHash})=${priorIds.length}
       AND COALESCE((SELECT sum(COALESCE(actual_lamports,reserved_lamports)) FROM signer_native_requests WHERE wallet=${i.wallet} AND plan_id=${i.planId} AND unsigned_expired_at IS NULL),0)+${i.lamports}::bigint<=${pilot?.totalDebitLamports ?? '0'}::bigint
       AND NOT EXISTS(SELECT 1 FROM signer_native_requests WHERE wallet=${i.wallet} AND plan_id=${i.planId} AND side=${i.side} AND NOT execution_id=ANY(${priorIds}::uuid[]))
       AND (${i.side}='buy' AND NOT EXISTS(SELECT 1 FROM signer_native_requests WHERE wallet=${i.wallet} AND plan_id=${i.planId} AND NOT execution_id=ANY(${priorIds}::uuid[])) OR
         ${i.side}='sell' AND (SELECT count(*) FROM signer_native_requests WHERE wallet=${i.wallet} AND plan_id=${i.planId} AND NOT execution_id=ANY(${priorIds}::uuid[]))=1
         AND EXISTS(SELECT 1 FROM signer_native_requests WHERE wallet=${i.wallet} AND plan_id=${i.planId} AND side='buy' AND mint=${i.mint} AND settlement='succeeded' AND unsigned_expired_at IS NULL AND credited_raw-corrected_raw>=${i.inputRaw}::numeric))
     ))
     AND (${i.side}='buy' OR EXISTS(
       SELECT 1 FROM (SELECT COALESCE(sum(CASE WHEN side='buy' THEN credited_raw-corrected_raw WHEN settlement NOT IN('failed','expired') THEN -input_raw ELSE 0 END),0) AS total,
        COALESCE(sum(CASE WHEN plan_id=${i.planId} THEN CASE WHEN side='buy' THEN credited_raw-corrected_raw WHEN settlement NOT IN('failed','expired') THEN -input_raw ELSE 0 END ELSE 0 END),0) AS owned,
        COALESCE(max(settled_slot),0) AS slot,count(*) FILTER(WHERE decimals<>${i.decimals}) AS incompatible
        FROM signer_native_requests WHERE wallet=${i.wallet} AND mint=${i.mint} AND unsigned_expired_at IS NULL) position
       WHERE NOT EXISTS(SELECT 1 FROM signer_inventory_reviews WHERE wallet=${i.wallet} AND mint=${i.mint} AND lane='native' AND state='applied' AND slot>${sell?.holdings.slot ?? 0})
        AND position.incompatible=0 AND position.slot<=${sell?.holdings.slot ?? 0} AND position.total>=position.owned AND position.owned>0
        AND position.total<=${sell?.holdings.rawAmount ?? '0'}::numeric
        AND ${i.inputRaw}::numeric<=div(position.owned*${sell?.leader.tokenRaw ?? '0'}::numeric,${sell?.leader.leaderTokenBeforeRaw ?? '1'}::numeric)
        AND to_timestamp(${sell?.holdings.fetchedAt ?? 0}/1000.0)>clock_timestamp()-interval '5 seconds'))
     ON CONFLICT DO NOTHING RETURNING execution_id`,
            ]);
            if (rows.length)
                return { kind: 'new' as const };
            const cached = await db `SELECT signed_transaction FROM signer_native_requests WHERE execution_id=${i.executionId} AND wallet=${i.wallet} AND request_hash=${i.hash} AND permission_hash=${i.permissionHash} AND state='signed' AND unsigned_expired_at IS NULL AND expires_at>clock_timestamp()`;
            if (cached.length) {
                verifyRaydium22SignedMessage(r.review, r.reviewHash, cached[0].signed_transaction);
                return { kind: 'signed' as const, signed: cached[0].signed_transaction as string };
            }
            throw Error('Independent native spend is unavailable. Recover the saved attempt.');
        },
        async complete(r: Token22SigningRequest, leaderSignature: string, signed: string, createdAt: number) {
            const i = nativeSigningIdentity(r, leaderSignature, createdAt), signature = verifyRaydium22SignedMessage(r.review, r.reviewHash, signed);
            const rows = await client() `UPDATE signer_native_requests SET state='signed',signed_transaction=${signed},signature=${signature},updated_at=clock_timestamp()
    WHERE execution_id=${i.executionId} AND request_hash=${i.hash} AND state IN ('requested','uncertain') AND signed_transaction IS NULL RETURNING execution_id,unsigned_expired_at`;
            if (rows.length !== 1 || rows[0].unsigned_expired_at)
                throw Error('Native signature saved after expiry or persistence unavailable.');
        },
        async uncertain(r: Token22SigningRequest, leaderSignature: string, createdAt: number) {
            const i = nativeSigningIdentity(r, leaderSignature, createdAt);
            await client() `UPDATE signer_native_requests SET state='uncertain',updated_at=clock_timestamp() WHERE execution_id=${i.executionId} AND request_hash=${i.hash} AND state='requested'`;
        },
    };
}
