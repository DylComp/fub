import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { isMint } from '../src/assets.js';
import { operationId } from '../src/funding-model.js';
import { parseAllocations, validateAllocation, type CopyPosition, type CopyAllocation, type InventoryReview } from '../src/copy-inventory.js';
import { readNativeInventory } from './native-inventory.js';
import { readCopyInventory } from './copy-inventory.js';
import { MAINNET_GENESIS } from './solana-network.js';
import { providerId, privyDid, type OwnerBinding } from './privy-owner.js';
import type { Rpc } from './funding.js';
export class InventoryCorrectionRefused extends Error {
}
const refused = () => new InventoryCorrectionRefused('Stop background access and resolve pending trades, then check the position again.');
export type PrivatePositionRow = {
    id: string;
    planId: string;
    side: 'buy' | 'sell';
    state: string;
    settlement: string;
    credit: string;
    corrected: string;
    input: string;
    slot: string | null;
    decimals: number;
};
// The snapshot contains only ledger counters, never signed transactions or permissions.
const pausedSql = `NOT EXISTS(SELECT 1 FROM signer_enrollments g JOIN signer_wallet_epochs e USING(wallet)
 WHERE g.wallet=$1 AND g.state='active' AND g.expires_at>clock_timestamp() AND e.epoch=g.epoch+1)`;
export function privatePositions(rows: PrivatePositionRow[]): CopyPosition[] {
    if (!rows.length || rows.length > 1000 || rows.some(r => r.settlement === 'pending'))
        throw refused();
    const amounts = new Map<string, bigint>();
    for (const r of rows) {
        const delta = r.side === 'buy' ? BigInt(r.credit) - BigInt(r.corrected) : r.settlement === 'succeeded' ? -BigInt(r.input) : 0n;
        amounts.set(r.planId, (amounts.get(r.planId) || 0n) + delta);
    }
    if (amounts.size > 25 || [...amounts.values()].some(v => v < 0n || v > 18446744073709551615n))
        throw refused();
    return [...amounts].sort(([a], [b]) => a.localeCompare(b)).map(([id, raw]) => ({ id, name: `Plan ${id.slice(0, 8)}`, version: 0, revision: '0', raw: raw.toString(), archived: false, enabled: false }));
}
export function correctionChanges(rows: PrivatePositionRow[], allocations: CopyAllocation[], balance: string) {
    const positions = privatePositions(rows);
    validateAllocation(positions, allocations, balance);
    const changes: {
        id: string;
        previous: string;
        next: string;
    }[] = [];
    for (const p of positions) {
        let remaining = BigInt(p.raw) - BigInt(allocations.find(a => a.id === p.id)!.raw);
        for (const r of rows.filter(r => r.planId === p.id && r.side === 'buy').sort((a, b) => a.id.localeCompare(b.id))) {
            const available = BigInt(r.credit) - BigInt(r.corrected), take = remaining < available ? remaining : available;
            if (take > 0n)
                changes.push({ id: r.id, previous: r.corrected, next: (BigInt(r.corrected) + take).toString() });
            remaining -= take;
            if (!remaining)
                break;
        }
        if (remaining)
            throw refused();
    }
    return changes;
}
function reviewRow(r: Record<string, any>): InventoryReview {
    return { id: r.id, wallet: r.wallet, mint: r.mint, positions: r.positions, balanceRaw: String(r.balance_raw), decimals: r.decimals, slot: Number(r.slot), expiresAt: new Date(r.expires_at).toISOString() };
}
export type PositionLane = 'standard' | 'native';
export function isolatedInventoryCorrections(url: string, rpc: Rpc, lane: PositionLane = 'standard') {
    if (lane !== 'standard' && lane !== 'native')
        throw refused();
    // These identifiers are selected from fixed code, never interpolated from a request.
    const ledger = lane === 'native' ? 'signer_native_requests' : 'signer_copy_inventory', idColumn = lane === 'native' ? 'execution_id' : 'attempt_id';
    const lock = (wallet: string, mint: string) => `${lane === 'native' ? 'native-inventory' : 'inventory'}:${wallet}:${mint}`;
    const snapshotSql = `SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.id),'[]'::jsonb) AS snapshot FROM (
 SELECT ${idColumn} AS id,plan_id AS "planId",side,state,settlement,credited_raw::text AS credit,
 corrected_raw::text AS corrected,input_raw::text AS input,settled_slot::text AS slot,decimals
 FROM ${ledger} WHERE wallet=$1 AND mint=$2 AND unsigned_expired_at IS NULL ORDER BY ${idColumn} LIMIT 1001) s`;
    const client = () => neon(url, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
    const bounds = (wallet: string, mint: string) => { if (!isMint(wallet) || !isMint(mint))
        throw refused(); };
    async function balance(wallet: string, mint: string, slot: number, signal: AbortSignal) {
        signal.throwIfAborted();
        if (await rpc('getGenesisHash', []) !== MAINNET_GENESIS)
            throw refused();
        const value = await (lane === 'native' ? readNativeInventory : readCopyInventory)(wallet, mint, rpc, slot);
        signal.throwIfAborted();
        return value;
    }
    return {
        async review(wallet: string, userId: string, walletId: string, mint: string, signal: AbortSignal): Promise<InventoryReview & {
            lane: PositionLane;
        }> {
            bounds(wallet, mint);
            const db = client();
            const [row] = await db.query(`SELECT snapshot,${pausedSql} AS paused FROM (${snapshotSql}) s`, [wallet, mint]);
            if (!row.paused)
                throw refused();
            const rows = row.snapshot as PrivatePositionRow[], positions = privatePositions(rows);
            const [previous] = await db `SELECT COALESCE(max(slot),0)::text AS slot FROM signer_inventory_reviews WHERE wallet=${wallet} AND mint=${mint} AND state='applied' AND lane=${lane}`;
            const minSlot = Math.max(Number(previous.slot), ...rows.map(r => Number(r.slot || 0)));
            if (!Number.isSafeInteger(minSlot))
                throw refused();
            const holdings = await balance(wallet, mint, minSlot, signal);
            if (rows.some(r => r.decimals !== holdings.decimals))
                throw refused();
            const id = randomUUID();
            signal.throwIfAborted();
            const [, , saved] = await db.transaction([
                db `SELECT pg_advisory_xact_lock(hashtextextended(${`enrollment:${wallet}`},0))`,
                db `SELECT pg_advisory_xact_lock(hashtextextended(${lock(wallet, mint)},0))`,
                db.query(`INSERT INTO signer_inventory_reviews(id,wallet,user_id,wallet_id,mint,snapshot,positions,balance_raw,decimals,slot,expires_at,lane)
     SELECT $3,$1,$4,$5,$2,s.snapshot,$7::jsonb,$8::numeric,$9,$10,clock_timestamp()+interval '2 minutes',$12
     FROM (${snapshotSql}) s WHERE s.snapshot=$6::jsonb AND ${pausedSql}
      AND to_timestamp($11/1000.0)>clock_timestamp()-interval '5 seconds'
      AND (SELECT count(*) FROM signer_inventory_reviews WHERE wallet=$1 AND created_at>clock_timestamp()-interval '1 minute')<10
     RETURNING *,balance_raw::text`, [wallet, mint, id, userId, walletId, JSON.stringify(rows), JSON.stringify(positions), holdings.rawAmount, holdings.decimals, holdings.slot, holdings.fetchedAt, lane]),
            ]);
            if (saved.length !== 1)
                throw refused();
            return { ...reviewRow(saved[0]), lane };
        },
        async apply(wallet: string, userId: string, walletId: string, id: string, value: unknown, signal: AbortSignal) {
            if (!isMint(wallet) || !operationId(id))
                throw refused();
            const allocations = parseAllocations(value), serialized = JSON.stringify(allocations), db = client();
            const [review] = await db `SELECT *,balance_raw::text FROM signer_inventory_reviews WHERE id=${id} AND wallet=${wallet} AND user_id=${userId} AND wallet_id=${walletId} AND lane=${lane}`;
            if (!review)
                throw refused();
            const result = (r: Record<string, any>) => {
                if (JSON.stringify(parseAllocations(r.allocations)) !== serialized)
                    throw refused();
                return { id: r.id, wallet: r.wallet, mint: r.mint, state: 'applied' as const, allocations: parseAllocations(r.allocations), slot: Number(r.slot) };
            };
            if (review.state === 'applied')
                return result(review);
            if (new Date(review.expires_at).getTime() <= Date.now())
                throw refused();
            const changes = correctionChanges(review.snapshot, allocations, String(review.balance_raw));
            const holdings = await balance(wallet, review.mint, Number(review.slot), signal);
            if (holdings.rawAmount !== String(review.balance_raw) || holdings.decimals !== review.decimals)
                throw refused();
            signal.throwIfAborted();
            const [, , saved] = await db.transaction([
                db `SELECT pg_advisory_xact_lock(hashtextextended(${`enrollment:${wallet}`},0))`,
                db `SELECT pg_advisory_xact_lock(hashtextextended(${lock(wallet, review.mint)},0))`,
                db.query(`WITH eligible AS (
     SELECT r.id FROM signer_inventory_reviews r CROSS JOIN (${snapshotSql}) s
     WHERE r.id=$3 AND r.wallet=$1 AND r.mint=$2 AND r.user_id=$4 AND r.wallet_id=$5 AND r.state='pending' AND r.lane=$11
      AND r.expires_at>clock_timestamp() AND r.snapshot=s.snapshot AND r.snapshot=$6::jsonb AND ${pausedSql}
      AND to_timestamp($7/1000.0)>clock_timestamp()-interval '5 seconds'
    ), changed AS (
     UPDATE ${ledger} i SET corrected_raw=c.next::numeric,updated_at=clock_timestamp()
     FROM jsonb_to_recordset($8::jsonb) AS c(id uuid,previous text,next text),eligible e
     WHERE i.${idColumn}=c.id AND i.wallet=$1 AND i.mint=$2 AND i.side='buy' AND i.settlement='succeeded'
      AND i.corrected_raw=c.previous::numeric AND c.next::numeric>i.corrected_raw AND c.next::numeric<=i.credited_raw RETURNING i.${idColumn}
    ) UPDATE signer_inventory_reviews r SET state='applied',allocations=$9::jsonb,changes=$8::jsonb,slot=$10,applied_at=clock_timestamp()
      FROM eligible e WHERE r.id=e.id AND (SELECT count(*) FROM changed)=jsonb_array_length($8::jsonb) RETURNING r.*`, [wallet, review.mint, id, userId, walletId, JSON.stringify(review.snapshot), holdings.fetchedAt, JSON.stringify(changes), serialized, holdings.slot, lane]),
            ]);
            if (saved.length === 1)
                return result(saved[0]);
            const [retry] = await db `SELECT * FROM signer_inventory_reviews WHERE id=${id} AND wallet=${wallet} AND user_id=${userId} AND wallet_id=${walletId} AND state='applied' AND lane=${lane}`;
            if (retry)
                return result(retry);
            throw refused();
        },
    };
}
export function isolatedPositionCorrections(url: string, rpc: Rpc) {
    const standard = isolatedInventoryCorrections(url, rpc, 'standard'), native = isolatedInventoryCorrections(url, rpc, 'native');
    const client = () => neon(url, { fetchOptions: { signal: AbortSignal.timeout(5000) } });
    return {
        async review(wallet: string, userId: string, walletId: string, mint: string, signal: AbortSignal) {
            if (!isMint(wallet) || !isMint(mint))
                throw refused();
            signal.throwIfAborted();
            const [r] = await client() `SELECT EXISTS(SELECT 1 FROM signer_copy_inventory WHERE wallet=${wallet} AND mint=${mint}) AS standard,
    EXISTS(SELECT 1 FROM signer_native_requests WHERE wallet=${wallet} AND mint=${mint}) AS native`;
            if (r.standard === r.native)
                throw refused();
            return (r.native ? native : standard).review(wallet, userId, walletId, mint, signal);
        },
        async apply(wallet: string, userId: string, walletId: string, id: string, value: unknown, signal: AbortSignal) {
            if (!isMint(wallet) || !operationId(id))
                throw refused();
            signal.throwIfAborted();
            const [r] = await client() `SELECT lane FROM signer_inventory_reviews WHERE id=${id} AND wallet=${wallet} AND user_id=${userId} AND wallet_id=${walletId}`;
            if (!r || !['standard', 'native'].includes(r.lane))
                throw refused();
            return (r.lane === 'native' ? native : standard).apply(wallet, userId, walletId, id, value, signal);
        },
    };
}
export function inventoryOwnerApi(options: {
    authenticate: (token: string) => Promise<string>;
    ownership: (binding: Omit<OwnerBinding, 'ownerId'>, delegated: boolean, signal: AbortSignal) => Promise<OwnerBinding>;
    positions: ReturnType<typeof isolatedInventoryCorrections>;
}) {
    const identify = async (token: string, wallet: string, walletId: string, signal: AbortSignal) => {
        if (!isMint(wallet) || !providerId(walletId))
            throw refused();
        signal.throwIfAborted();
        const userId = await options.authenticate(token);
        if (!privyDid(userId))
            throw refused();
        const owner = await options.ownership({ userId, wallet, walletId }, false, signal);
        if (owner.userId !== userId || owner.wallet !== wallet || owner.walletId !== walletId)
            throw refused();
        signal.throwIfAborted();
        return userId;
    };
    return {
        review: async (token: string, wallet: string, walletId: string, mint: string, signal: AbortSignal) => options.positions.review(wallet, await identify(token, wallet, walletId, signal), walletId, mint, signal),
        apply: async (token: string, wallet: string, walletId: string, id: string, allocations: unknown, signal: AbortSignal) => options.positions.apply(wallet, await identify(token, wallet, walletId, signal), walletId, id, allocations, signal),
    };
}
