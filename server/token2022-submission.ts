import { randomUUID } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import { token22Journal } from "./token2022-journal.js";
import { token22SigningAuthority } from "./token2022-authority.js";
import { bindRaydium22Signed } from "./native-copy-review.js";
import { preflightToken22 } from "./token2022-preflight.js";
import { broadcastNativeTransaction, type NativeBroadcastResult } from "./native-broadcast.js";
import { isMint } from "../src/assets.js";
import { operationId } from "../src/funding-model.js";
import type { Rpc } from "./funding.js";

// Internal opt-in adapter. The configured standalone host supplies the signer;
// no public API or default process enables execution.
// Retries inspect the durable claim; they never submit a second time.
export function token22Submission(options: {
  url: string;
  rpc: Rpc;
  allowSubmission?: boolean;
  signal?: AbortSignal;
}) {
  const { url, rpc } = options,
    journal = token22Journal(url);
  const client = () =>
    neon(url, { fetchOptions: { signal: AbortSignal.timeout(10000) } });
  return {
    async submit(wallet: string, id: string) {
      if (options.allowSubmission !== true)
        throw Error("Native SOL submission is disabled.");
      options.signal?.throwIfAborted();
      if (!isMint(wallet) || !operationId(id))
        throw Error("Invalid submission identity.");
      const sql = client();
      const prior =
        await sql`SELECT state FROM fomo_token22_submissions WHERE execution_id=${id} AND wallet=${wallet}`;
      if (prior.length) return { kind: "already-claimed" as const };
      const saved = await journal.get(wallet, id);
      if (
        !saved ||
        saved.state !== "signed" ||
        !saved.execution ||
        saved.review.expiresAt <= Date.now()
      )
        return { kind: "blocked" as const };
      const scopeHash = await token22SigningAuthority(
        url,
        wallet,
        id,
        saved.review,
      );
      if (!scopeHash) return { kind: "blocked" as const };
      const active =
        await sql`SELECT r.execution_id FROM fomo_token22_authorized_reservations r
      WHERE r.execution_id=${id} AND r.wallet=${wallet} AND r.scope_hash=${scopeHash}
        AND EXISTS(SELECT 1 FROM fomo_copy_dispatch_control WHERE name='execution' AND enabled)`;
      if (!active.length) return { kind: "blocked" as const };
      const preflight = await preflightToken22(saved, rpc);
      options.signal?.throwIfAborted();
      const r = saved.review,
        e = saved.execution,
        claim = randomUUID();
      bindRaydium22Signed(r, saved.reviewHash, e.signed, preflight.blockHeight);
      const [, claimed] = await sql.transaction([
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${wallet},0))`,
        sql`INSERT INTO fomo_token22_submissions(execution_id,wallet,claim_id,signature,review_hash,preflight_slot,block_height,checked_at)
        SELECT e.id,e.wallet,${claim},e.signature,e.review_hash,${preflight.slot},${preflight.blockHeight},to_timestamp(${preflight.checkedAt}/1000.0)
        FROM fomo_token22_executions e JOIN fomo_token22_authorized_reservations r ON r.execution_id=e.id AND r.wallet=e.wallet
        WHERE e.id=${id} AND e.wallet=${wallet} AND e.state='signed' AND e.expires_at>clock_timestamp()
          AND e.review_hash=${saved.reviewHash} AND e.review=${JSON.stringify(saved.review)}::jsonb
          AND e.signature=${e.signature} AND e.signed_transaction=${e.signed} AND r.scope_hash=${scopeHash}
          AND EXISTS(SELECT 1 FROM fomo_copy_dispatch_control WHERE name='execution' AND enabled)
          AND ${preflight.blockHeight}<=${r.lastValidBlockHeight} AND ${preflight.slot}>=${r.minContextSlot}
          AND to_timestamp(${preflight.checkedAt}/1000.0) BETWEEN clock_timestamp()-interval '5 seconds' AND clock_timestamp()+interval '1 second'
          AND (r.side='buy' OR (
            EXISTS(SELECT 1 FROM fomo_token22_positions p WHERE p.plan_id=r.plan_id AND p.mint=r.mint AND p.decimals=r.decimals AND p.raw_amount>=r.input_raw AND p.last_slot<=${preflight.slot})
            AND (SELECT COALESCE(sum(p.raw_amount),0) FROM fomo_token22_positions p JOIN fomo_copy_plans c ON c.id=p.plan_id WHERE c.wallet=${wallet} AND p.mint=r.mint)<=${preflight.sourceRaw}::numeric))
        ON CONFLICT DO NOTHING RETURNING execution_id`,
      ]);
      if (!claimed.length) return { kind: "blocked" as const };
      // A crash or timeout after this point is uncertain, including a lost claim
      // response. Recovery uses the existing signature; no claim lease permits resend.
      let result: NativeBroadcastResult = { kind: 'uncertain' };
      try {
        bindRaydium22Signed(r, saved.reviewHash, e.signed, preflight.blockHeight);
        result = await broadcastNativeTransaction(rpc, e.signed, e.signature, preflight.slot, options.signal);
      } catch {
        // A review expiring after the durable claim must not reopen that claim.
        // This local refusal is not attributed to an RPC response.
      }
      await sql`UPDATE fomo_token22_submissions SET state=${result.kind},
        rpc_diagnostic_kind=${result.diagnostic?.kind ?? null},rpc_diagnostic_code=${result.diagnostic?.code ?? null},finished_at=clock_timestamp()
      WHERE execution_id=${id} AND wallet=${wallet} AND claim_id=${claim} AND state='claimed'`;
      return { kind: result.kind }; // RPC acceptance is not chain confirmation.
    },
  };
}
