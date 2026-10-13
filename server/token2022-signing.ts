import { randomUUID } from "node:crypto";
import {NATIVE_SIGNING_TIMEOUT_MS} from './native-signing-deadline.js';
import { neon } from "@neondatabase/serverless";
import { token22Journal } from "./token2022-journal.js";
import {
  assertToken22PermissionReview,
  verifyToken22Permission,
  type Token22Permission,
} from "./token2022-permission.js";
import type { Token22Preflight } from "./token2022-preflight.js";
import type { Raydium22ExecutionReview } from "./token2022-recovery.js";

export type Token22SigningRequest = {
  wallet: string;
  executionId: string;
  claimId: string;
  idempotencyKey: string;
  permission: {
    scope: Token22Permission;
    signature: string;
    scopeHash: string;
  };
  review: Raydium22ExecutionReview;
  reviewHash: string;
  expiresAt: number;
};
// A real integration must enforce provider policy and only return signed bytes.
// A sign-and-send adapter, exported key, or unrelated wallet is not supported.
export type Token22Signer = (
  request: Token22SigningRequest,
  signal: AbortSignal,
) => Promise<string>;

// Separate from the engineering journal's beginSigning: unbound records cannot
// use this path. The wallet lock orders this claim against pause/stop/revocation.
export async function claimToken22Signing(
  url: string,
  wallet: string,
  id: string,
  evidence: Token22Preflight,
): Promise<Token22SigningRequest | null> {
  const journal = token22Journal(url),
    saved = await journal.get(wallet, id);
  if (!saved || saved.state !== "prepared" || saved.execution) return null;
  const r = saved.review;
  if (
    ![evidence.slot, evidence.blockHeight, evidence.checkedAt].every(
      Number.isSafeInteger,
    ) ||
    evidence.slot < r.minContextSlot ||
    evidence.blockHeight < 1 ||
    evidence.blockHeight > r.lastValidBlockHeight ||
    !/^(0|[1-9][0-9]{0,19})$/.test(evidence.sourceRaw)
  )
    throw Error("Invalid signing simulation evidence.");
  const sql = neon(url, {
    fetchOptions: { signal: AbortSignal.timeout(8000) },
  });
  const rows =
    await sql`SELECT g.scope,g.signature,g.scope_hash FROM fomo_token22_authorized_reservations a
    JOIN fomo_token22_permissions g ON g.id=a.permission_id WHERE a.execution_id=${id} AND a.wallet=${wallet}`;
  if (!rows[0]) return null;
  const g = rows[0],
    scope = g.scope as Token22Permission;
  if (verifyToken22Permission(scope, g.signature) !== g.scope_hash)
    throw Error("Permission proof changed.");
  assertToken22PermissionReview(scope, r);
  const claimId = randomUUID();
  const [, claimed] = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
    sql`UPDATE fomo_token22_executions e SET state='signing',signing_claim=${claimId},updated_at=clock_timestamp()
    FROM fomo_token22_authorized_reservations a JOIN fomo_token22_permissions g ON g.id=a.permission_id
    WHERE e.id=${id} AND e.wallet=${wallet} AND e.id=a.execution_id AND e.wallet=a.wallet
      AND e.state='prepared' AND e.signing_claim IS NULL AND e.signature IS NULL AND e.expires_at>clock_timestamp()
      AND e.review_hash=${saved.reviewHash} AND e.review=${JSON.stringify(r)}::jsonb
      AND g.scope_hash=${g.scope_hash} AND g.scope=${JSON.stringify(scope)}::jsonb AND g.signature=${g.signature}
      AND EXISTS(SELECT 1 FROM fomo_copy_dispatch_control WHERE name='execution' AND enabled)
      AND to_timestamp(${evidence.checkedAt}/1000.0) BETWEEN clock_timestamp()-interval '5 seconds' AND clock_timestamp()+interval '1 second'
      AND (a.side='buy' OR (
        EXISTS(SELECT 1 FROM fomo_token22_positions p WHERE p.plan_id=a.plan_id AND p.mint=a.mint AND p.decimals=a.decimals AND p.raw_amount>=a.input_raw AND p.last_slot<=${evidence.slot})
        AND (SELECT COALESCE(sum(p.raw_amount),0) FROM fomo_token22_positions p JOIN fomo_copy_plans c ON c.id=p.plan_id WHERE c.wallet=${wallet} AND p.mint=a.mint)<=${evidence.sourceRaw}::numeric))
    RETURNING e.id`,
  ]);
  if (!claimed.length) return null;
  return {
    wallet,
    executionId: id,
    claimId,
    idempotencyKey: `${id}:${saved.reviewHash}`,
    permission: { scope, signature: g.signature, scopeHash: g.scope_hash },
    review: r,
    reviewHash: saved.reviewHash,
    expiresAt: r.expiresAt,
  };
}

// Late replies are validated and journaled even after cancellation/expiry. They
// are never sent here. A lost provider response keeps the claim and budget held.
export async function requestToken22Signature(
  url: string,
  request: Token22SigningRequest,
  signer: Token22Signer,
  signal?: AbortSignal,
): Promise<"saved" | "uncertain"> {
  const duration = Math.min(NATIVE_SIGNING_TIMEOUT_MS, request.expiresAt - Date.now());
  if (duration <= 0 || signal?.aborted) return "uncertain";
  const abort = new AbortController(),
    combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    // Both promise branches handle rejection, including after the caller times out.
    const pending = Promise.resolve()
      .then(async () => {
        combined.throwIfAborted();
        const signed = await signer(structuredClone(request), combined);
        return (await token22Journal(url).saveSigned(
          request.wallet,
          request.executionId,
          request.claimId,
          signed,
        ))
          ? ("saved" as const)
          : ("uncertain" as const);
      })
      .catch(() => "uncertain" as const);
    return await Promise.race([
      pending,
      new Promise<"uncertain">((resolve) => {
        onAbort = () => resolve("uncertain");
        combined.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => abort.abort(), duration);
        if (combined.aborted) onAbort();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) combined.removeEventListener("abort", onAbort);
  }
}
