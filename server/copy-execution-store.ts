import type { DispatchTicket } from "./copy-dispatch-store.js";
import { neon } from "@neondatabase/serverless";
import { copyLedger, rowAttempt } from "./copy-ledger.js";
import { copyIntentForAttempt, verifyCopySwapSignature } from "./copy-swap.js";
import type { ReviewedCopySwap, preflightCopySwap } from "./copy-swap.js";
import type { verifyCopyLanded } from "./copy-outcome.js";
import type { CopyExecution } from "./copy-execution-model.js";
import {
  verifyCopyPermission,
  assertCopyPermissionAttempt,
  assertCopyPermissionRoute,
} from "./copy-permission-model.js";

type Preflight = Awaited<ReturnType<typeof preflightCopySwap>>;
type Failure = Extract<ReturnType<typeof verifyCopyLanded>, { kind: "failed" }>;
export function copyExecutionStore(url: string, dispatch?: DispatchTicket) {
  const ledger = copyLedger(url);
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(10000) } });
  async function authorization(wallet: string, id: string) {
    const sql = client();
    const rows =
      await sql`SELECT a.*,g.scope AS permission_scope,g.signature AS permission_signature,g.scope_hash AS permission_hash,
      j.id AS signing_dispatch_id,j.lease_id AS signing_lease_id,j.lease_until AS signing_lease_until,j.deadline AS signing_deadline
      FROM fomo_copy_attempts a JOIN fomo_copy_authorized_plans p ON p.id=a.plan_id AND p.wallet=a.wallet
      JOIN fomo_copy_permissions g ON g.id=p.permission_id
      LEFT JOIN fomo_copy_dispatch j ON j.id::text=a.data->>'dispatchId' AND j.wallet=a.wallet AND j.plan_id=a.plan_id AND j.leader_signature=a.leader_signature
      WHERE a.wallet=${wallet} AND a.id=${id} AND a.state='reserved' AND a.expires_at>statement_timestamp()
        AND p.enabled AND p.version=a.plan_version AND a.data->>'permissionId'=p.permission_id::text
        AND a.expires_at<=p.permission_expires_at
            AND fomo_copy_dispatch_allowed(a.wallet,a.plan_id,a.leader_signature,a.data->>'dispatchId',${dispatch?.leaseId || null})
            AND a.slippage_bps<=(p.data->>'slippageBps')::integer
            AND ((a.side='buy' AND a.reserved_cents=(p.data->>'buyCents')::bigint) OR (a.side='sell' AND a.reserved_cents=0 AND (p.data->>'copySells')::boolean))`;
    if (!rows[0]) return null;
    if (
      verifyCopyPermission(
        rows[0].permission_scope,
        rows[0].permission_signature,
      ) !== rows[0].permission_hash
    )
      throw new Error("Copy permission proof does not match its review.");
    const attempt = rowAttempt(rows[0]);
    assertCopyPermissionAttempt(rows[0].permission_scope, attempt);
    return {
      attempt,
      permission: {
        scope: rows[0].permission_scope,
        signature: rows[0].permission_signature as string,
        hash: rows[0].permission_hash as string,
      },
      dispatch: rows[0].signing_dispatch_id
        ? {
            id: rows[0].signing_dispatch_id as string,
            leaseId: rows[0].signing_lease_id as string,
            leaseUntil: new Date(rows[0].signing_lease_until).getTime(),
            deadline: new Date(rows[0].signing_deadline).getTime(),
          }
        : null,
    };
  }
  async function authorized(wallet: string, id: string) {
    return (await authorization(wallet, id))?.attempt || null;
  }
  return {
    authorized,
    // One database snapshot ties the proof, reservation and current dispatch
    // together. Signers must not assemble authority from several stale reads.
    signingAuthorization: authorization,
    // Only server preparation calls this. There is no endpoint for accepting a review.
    async savePrepared(wallet: string, id: string, review: ReviewedCopySwap) {
      const auth = await authorization(wallet, id);
      const attempt = auth?.attempt;
      if (!auth || !attempt || attempt.state !== "reserved") return null;
      assertCopyPermissionRoute(auth.permission.scope, review);
      const intent = copyIntentForAttempt(attempt);
      if (
        Object.entries(intent).some(
          ([key, value]) => review.intent[key as keyof typeof intent] !== value,
        ) ||
        review.expiresAt !== intent.expiresAt ||
        review.reviewedAt > Date.now() ||
        Date.now() - review.reviewedAt > 30000
      )
        throw new Error("Prepared swap does not match the reservation.");
      const prepared = { review, savedAt: Date.now() },
        sql = client();
      const [, rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`UPDATE fomo_copy_attempts a SET data=a.data || ${JSON.stringify({ prepared })}::jsonb,updated_at=statement_timestamp()
          FROM fomo_copy_authorized_plans p WHERE a.wallet=${wallet} AND a.id=${id} AND a.state='reserved' AND a.expires_at>statement_timestamp()
          AND p.id=a.plan_id AND p.enabled AND NOT p.archived
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls control WHERE control.wallet=p.wallet) AND p.version=a.plan_version AND a.data->>'permissionId'=p.permission_id::text AND a.expires_at<=p.permission_expires_at
            AND fomo_copy_dispatch_allowed(a.wallet,a.plan_id,a.leader_signature,a.data->>'dispatchId',${dispatch?.leaseId || null})
            AND a.slippage_bps<=(p.data->>'slippageBps')::integer
            AND ((a.side='buy' AND a.reserved_cents=(p.data->>'buyCents')::bigint) OR (a.side='sell' AND a.reserved_cents=0 AND (p.data->>'copySells')::boolean))
          AND a.data->>'minOutputRaw'=${attempt.minOutputRaw} AND a.slippage_bps=${intent.slippageBps}
          RETURNING a.*`,
      ]);
      return rows[0] ? rowAttempt(rows[0]) : null;
    },
    async claim(
      wallet: string,
      id: string,
      signed: string,
      preflight: Preflight,
    ) {
      const attempt = await authorized(wallet, id),
        review = attempt?.prepared?.review;
      if (!attempt || attempt.state !== "reserved" || !review) return null;
      const intent = copyIntentForAttempt(attempt);
      if (
        Object.entries(intent).some(
          ([key, value]) => review.intent[key as keyof typeof intent] !== value,
        )
      )
        throw new Error("Copy reservation changed after review.");
      const signature = verifyCopySwapSignature(review, signed);
      if (
        (review.intermediate
          ? !preflight.intermediate ||
            preflight.intermediate.address !== review.intermediate.address ||
            preflight.intermediate.wallet !== wallet
          : !!preflight.intermediate) ||
        preflight.input.wallet !== wallet ||
        preflight.output.wallet !== wallet ||
        preflight.input.mint !== intent.inputMint ||
        preflight.output.mint !== intent.outputMint ||
        preflight.input.source !== review.source ||
        preflight.output.source !== review.destination ||
        preflight.input.decimals !==
          (attempt.side === "sell" ? attempt.inputDecimals : 6) ||
        preflight.output.decimals !== attempt.outputDecimals ||
        BigInt(preflight.input.rawAmount) < BigInt(intent.inputRaw) ||
        !Number.isSafeInteger(preflight.checkedAt) ||
        preflight.checkedAt > Date.now() ||
        Date.now() - preflight.checkedAt > 10000 ||
        [
          preflight.input,
          preflight.output,
          ...(preflight.intermediate ? [preflight.intermediate] : []),
        ].some(
          (s) =>
            !Number.isSafeInteger(s.slot) ||
            s.slot <
              Math.max(review.lifetime.slot, review.routeContextSlot || 0) ||
            !Number.isSafeInteger(s.fetchedAt) ||
            s.fetchedAt > Date.now() ||
            Date.now() - s.fetchedAt > 10000,
        ) ||
        !/^[1-9]\d{0,9}$/.test(preflight.feeLamports) ||
        BigInt(preflight.feeLamports) > BigInt(intent.maxNetworkFeeLamports) ||
        !/^(0|[1-9]\d{0,9})$/.test(preflight.rentLamports) ||
        BigInt(preflight.rentLamports) > 2500000n ||
        !preflight.simulation ||
        !Number.isSafeInteger(preflight.simulation.slot) ||
        preflight.simulation.slot <
          Math.max(
            preflight.input.slot,
            preflight.output.slot,
            preflight.intermediate?.slot || 0,
            review.routeContextSlot || 0,
            review.lifetime.slot,
          ) ||
        preflight.simulation.inputRaw !== intent.inputRaw ||
        !/^[1-9]\d{0,19}$/.test(preflight.simulation.outputRaw) ||
        BigInt(preflight.simulation.outputRaw) > 18446744073709551615n ||
        BigInt(preflight.simulation.outputRaw) < BigInt(review.minimum) ||
        !/^[1-9]\d{0,9}$/.test(preflight.simulation.feeLamports) ||
        BigInt(preflight.simulation.feeLamports) >
          BigInt(preflight.feeLamports) ||
        !/^(0|[1-9]\d{0,9})$/.test(preflight.simulation.rentLamports) ||
        BigInt(preflight.simulation.rentLamports) >
          BigInt(preflight.rentLamports)
      )
        throw new Error("Copy preflight is stale or inconsistent.");
      const execution: CopyExecution = {
        version: 1,
        signed,
        feeLamports: preflight.feeLamports,
        rentLamports: preflight.rentLamports,
        minContextSlot: Math.max(
          review.lifetime.slot,
          review.routeContextSlot || 0,
          preflight.input.slot,
          preflight.output.slot,
          preflight.simulation.slot,
          ...review.lookupTables.map((p) => p.contextSlot),
        ),
      };
      const sql = client(),
        inventorySlot = preflight.input.slot;
      const [, , rows] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`SELECT pg_advisory_xact_lock_shared(hashtextextended('copy-dispatch-claim',0))`,
        sql`UPDATE fomo_copy_attempts a SET state='submitting',signature=${signature},
          data=a.data || ${JSON.stringify({ messageHash: review.messageHash, execution, inventorySlot })}::jsonb,updated_at=statement_timestamp()
          FROM fomo_copy_authorized_plans p WHERE a.wallet=${wallet} AND a.id=${id} AND a.state='reserved' AND a.expires_at>statement_timestamp()
          AND a.data->'prepared'=${JSON.stringify(attempt.prepared)}::jsonb
          AND p.id=a.plan_id AND p.enabled AND NOT p.archived
            AND NOT EXISTS(SELECT 1 FROM fomo_copy_controls control WHERE control.wallet=p.wallet) AND p.version=a.plan_version AND a.data->>'permissionId'=p.permission_id::text AND a.expires_at<=p.permission_expires_at
            AND fomo_copy_dispatch_allowed(a.wallet,a.plan_id,a.leader_signature,a.data->>'dispatchId',${dispatch?.leaseId || null})
            AND a.slippage_bps<=(p.data->>'slippageBps')::integer
            AND ((a.side='buy' AND a.reserved_cents=(p.data->>'buyCents')::bigint) OR (a.side='sell' AND a.reserved_cents=0 AND (p.data->>'copySells')::boolean))
          AND to_timestamp(${preflight.checkedAt}/1000.0)>=statement_timestamp()-interval '10 seconds'
          AND to_timestamp(${Math.min(preflight.input.fetchedAt, preflight.output.fetchedAt)}/1000.0)>=statement_timestamp()-interval '10 seconds'
          AND NOT EXISTS(SELECT 1 FROM fomo_copy_attempts settled WHERE settled.wallet=${wallet} AND settled.mint=a.mint AND settled.state='confirmed'
            AND (settled.data->'receipt'->>'slot')::bigint>${Math.min(preflight.input.slot, preflight.output.slot)})
          AND ((a.side='buy' AND a.budget_day=(statement_timestamp() AT TIME ZONE 'UTC')::date) OR
            (a.side='sell' AND (p.data->>'copySells')::boolean AND (a.data->>'inventorySlot')::bigint<=${inventorySlot}
              AND EXISTS(SELECT 1 FROM fomo_copy_positions x WHERE x.plan_id=a.plan_id AND x.mint=a.mint
                AND x.raw_amount=(a.data->>'positionBeforeRaw')::numeric AND x.raw_amount>=(a.data->>'inputRaw')::numeric)
              AND (SELECT COALESCE(sum(pos.raw_amount),0) FROM fomo_copy_positions pos JOIN fomo_copy_plans owners ON owners.id=pos.plan_id
                WHERE owners.wallet=${wallet} AND pos.mint=a.mint)<=${preflight.input.rawAmount}::numeric))
          RETURNING a.*`,
      ]);
      return rows[0] ? rowAttempt(rows[0]) : null;
    },
    async settleFailure(wallet: string, id: string, failure: Failure) {
      const sql = client();
      await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`WITH eligible AS (
          SELECT * FROM fomo_copy_attempts WHERE wallet=${wallet} AND id=${id} AND state IN ('submitting','unknown')
            AND signature=${failure.signature} AND data->>'messageHash'=${failure.messageHash} AND data->'execution'->>'version'='1'
        ), restored AS (
          UPDATE fomo_copy_budgets b SET reserved_cents=b.reserved_cents-a.reserved_cents FROM eligible a
            WHERE b.plan_id=a.plan_id AND b.day=a.budget_day AND b.reserved_cents>=a.reserved_cents RETURNING b.plan_id
        ) UPDATE fomo_copy_attempts a SET state='failed',data=a.data || ${JSON.stringify({ failure })}::jsonb,updated_at=statement_timestamp()
          FROM restored r WHERE a.id=${id} AND a.wallet=${wallet} AND a.plan_id=r.plan_id`,
      ]);
      return ledger.get(wallet, id);
    },
  };
}
