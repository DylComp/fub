import {validateSignedNativeExpiry} from './native-expiry-proof.js';
import { neon } from "@neondatabase/serverless";
import { isMint } from "../src/assets.js";
import { operationId } from "../src/funding-model.js";
import { CopyValidation } from "../src/copy-account.js";
import { tokenUnits } from "../src/token-fees.js";
import type { NativeHistoryReport } from "../src/native-history.js";

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
export async function token22History(
  url: string,
  wallet: string,
  planId: string,
): Promise<NativeHistoryReport | null> {
  if (!isMint(wallet) || !operationId(planId))
    throw new CopyValidation("Invalid trade history request.");
  const sql = neon(url, {
    fetchOptions: { signal: AbortSignal.timeout(10000) },
  });
  const [plans, rows] = await sql.transaction(
    [
      sql`SELECT statement_timestamp() AS checked_at,(statement_timestamp() AT TIME ZONE 'UTC')::date::text AS day,
      COALESCE(b.spent_lamports,0)::text AS spent,COALESCE(b.reserved_lamports,0)::text AS reserved,
      (SELECT COALESCE(sum(r.reserved_lamports),0)::text FROM fomo_token22_reservations r WHERE r.plan_id=p.id AND r.state='reserved') AS held,
      (SELECT COALESCE(sum(x.proceeds_lamports),0)::text FROM fomo_token22_positions x WHERE x.plan_id=p.id) AS proceeds
      FROM fomo_copy_plans p LEFT JOIN fomo_token22_budgets b ON b.plan_id=p.id AND b.day=(statement_timestamp() AT TIME ZONE 'UTC')::date
      WHERE p.id=${planId} AND p.wallet=${wallet}`,
      sql`SELECT e.id,r.mint,r.side,r.input_raw::text,r.decimals,r.reserved_lamports::text,r.state AS accounting,r.issue,
      e.state,e.signature,e.message_hash,e.signed_expiry,e.review,e.review_hash,e.signing_claim,e.review->>'feeLamports' AS expected_fee,e.review->'accounts'->>'minimum' AS minimum,
      e.last_checked_at,e.next_check_at,e.checks,e.last_outcome,e.created_at,e.expires_at,GREATEST(e.updated_at,r.updated_at,s.started_at,s.finished_at) AS updated_at,
      s.state AS submission,o.outcome
      FROM fomo_token22_reservations r JOIN fomo_copy_plans p ON p.id=r.plan_id AND p.wallet=r.wallet
      JOIN fomo_token22_executions e ON e.id=r.execution_id AND e.wallet=r.wallet
      LEFT JOIN fomo_token22_submissions s ON s.execution_id=e.id AND s.wallet=e.wallet
      LEFT JOIN fomo_token22_outcomes o ON o.execution_id=e.id AND o.wallet=e.wallet
      WHERE p.wallet=${wallet} AND p.id=${planId}
      ORDER BY (r.state='reserved') DESC,e.created_at DESC,e.id DESC LIMIT 51`,
    ],
    { isolationLevel: "RepeatableRead", readOnly: true },
  );
  if (!plans[0]) return null;
  const p = plans[0];
  return {
    wallet,
    planId,
    checkedAt: iso(p.checked_at)!,
    day: p.day,
    spentTodayLamports: p.spent,
    reservedTodayLamports: p.reserved,
    heldLamports: p.held,
    proceedsLamports: p.proceeds,
    hasMore: rows.length > 50,
    trades: rows.slice(0, 50).map((r) => {
      const terminal = r.state === "confirmed" || r.state === "failed",
        o = r.outcome;
      if (
        terminal &&
        (!o ||
          o.kind !== (r.state === "confirmed" ? "succeeded" : "failed") ||
          o.signature !== r.signature ||
          o.messageHash !== r.message_hash ||
          o.feeLamports !== r.expected_fee ||
          (r.state === "confirmed" &&
            (o.inputRaw !== r.input_raw ||
              tokenUnits(o.outputRaw) < tokenUnits(r.minimum))))
      )
        throw Error("Trade evidence could not be verified.");
      if(r.signed_expiry)validateSignedNativeExpiry(r.signed_expiry,{wallet,executionId:r.id,claimId:r.signing_claim,reviewHash:r.review_hash},r.review,r.signature);
      return {
        id: r.id,
        mint: r.mint,
        side: r.side,
        inputRaw: r.input_raw,
        decimals: r.decimals,
        state: r.signed_expiry ? "expired" : r.state,
        accounting: r.accounting,
        accountingBlocked: r.issue !== null,
        reservedLamports: r.reserved_lamports,
        ...(r.signature ? { signature: r.signature } : {}),
        submission: r.submission ?? null,
        ...(terminal
          ? { feeLamports: tokenUnits(o.feeLamports).toString() }
          : {}),
        ...(r.state === "confirmed"
          ? {
              outputRaw: tokenUnits(o.outputRaw).toString(),
              rentLamports: tokenUnits(o.rentLamports).toString(),
              tokenFeeRaw: tokenUnits(o.observedTokenFeeRaw).toString(),
            }
          : {}),
        checkedAt: iso(r.last_checked_at),
        reviewExpiresAt: iso(r.expires_at)!,
        nextCheckAt: r.state === "signed" && !r.signed_expiry ? iso(r.next_check_at) : null,
        checks: r.checks,
        recovery: r.last_outcome,
        createdAt: iso(r.created_at)!,
        updatedAt: iso(r.updated_at)!,
      };
    }),
  };
}
