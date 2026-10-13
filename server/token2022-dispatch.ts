import { neon } from "@neondatabase/serverless";
import { isMint } from "../src/assets.js";
import { operationId } from "../src/funding-model.js";
import type { Rpc } from "./funding.js";
import { boundedDispatchRpc } from "./copy-dispatch-worker.js";
import { token22Journal } from "./token2022-journal.js";
import { token22Accounting } from "./token2022-accounting.js";
import { preflightUnsignedToken22 } from "./token2022-preflight.js";
import {
  claimToken22Signing,
  requestToken22Signature,
  type Token22Signer,
} from "./token2022-signing.js";
import { token22Submission } from "./token2022-submission.js";

export type Token22DispatchOptions = {
  url: string;
  rpc: Rpc;
  signer?: Token22Signer;
  enabled?: boolean;
  signal?: AbortSignal;
};
// Internal orchestrator for a SERVER-PREPARED review and its classified leader
// event. The standalone host supplies explicit opt-in and a reviewed signer.
// Discovery/build/enrollment remain upstream. Retries never replace the review.
export async function runToken22Dispatch(
  options: Token22DispatchOptions,
  input: {
    wallet: string;
    planId: string;
    executionId: string;
    leaderSignature: string;
  },
) {
  if (options.enabled !== true || !options.signer)
    return { outcome: "disabled" as const };
  const { wallet, planId, executionId: id, leaderSignature } = input;
  if (!isMint(wallet) || !operationId(planId) || !operationId(id))
    throw Error("Invalid native dispatch identity.");
  options.signal?.throwIfAborted();
  const sql = neon(options.url, {
    fetchOptions: { signal: AbortSignal.timeout(8000) },
  });
  const control =
    await sql`SELECT enabled FROM fomo_copy_dispatch_control WHERE name='execution'`;
  if (control[0]?.enabled !== true) return { outcome: "disabled" as const };
  const journal = token22Journal(options.url),
    accounting = token22Accounting(options.url);
  const saved = await journal.get(wallet, id);
  if (!saved) return { outcome: "blocked" as const };
  const rpc = boundedDispatchRpc(
    options.rpc,
    saved.review.expiresAt,
    options.signal,
  );
  let reservation: Record<string, any> | null = await accounting.get(
    wallet,
    id,
  );
  if (!reservation && saved.state === "prepared")
    reservation = await accounting.reserve(
      wallet,
      planId,
      id,
      leaderSignature,
      rpc,
    );
  if (
    !reservation ||
    reservation.plan_id !== planId ||
    reservation.leader_signature !== leaderSignature
  )
    return { outcome: "blocked" as const };
  if (["confirmed", "failed", "canceled"].includes(saved.state)) {
    await accounting.apply(wallet, id);
    return {
      outcome:
        (await accounting.get(wallet, id))?.state === "reserved"
          ? ("accounting-pending" as const)
          : ("settled" as const),
    };
  }
  if (saved.state === "signing")
    return { outcome: "awaiting-signature" as const };
  options.signal?.throwIfAborted();
  if (saved.state === "prepared") {
    if (saved.review.expiresAt <= Date.now()) {
      await accounting.apply(wallet, id);
      return { outcome: "expired" as const };
    }
    const evidence = await preflightUnsignedToken22(saved, rpc);
    options.signal?.throwIfAborted();
    const request = await claimToken22Signing(
      options.url,
      wallet,
      id,
      evidence,
    );
    if (!request) return { outcome: "blocked" as const };
    const result = await requestToken22Signature(
      options.url,
      request,
      options.signer,
      options.signal,
    );
    if (result !== "saved") return { outcome: "awaiting-signature" as const };
  }
  // A reply arriving after stop/expiry is still saved above. Submission independently
  // rechecks permission, pause, inventory, TTL and a fresh SIGNED simulation.
  if (options.signal?.aborted) return { outcome: "signature-saved" as const };
  const result = await token22Submission({
    url: options.url,
    rpc,
    allowSubmission: true,
    signal: options.signal,
  }).submit(wallet, id);
  return { outcome: result.kind };
}
