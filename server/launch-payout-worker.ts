import { randomUUID } from "node:crypto";
import { verifyPayoutSignature } from "./launch-payout-model.js";
import { verifyPayoutPlan } from "./launch-payout-chain.js";
import type { PayoutOutcome } from "./launch-payout-model.js";
import type { LaunchPayoutStore } from "./launch-payout-store.js";
import type { LaunchPayoutChain } from "./launch-payout-chain.js";

export async function runLaunchPayout(deps: {
  store: LaunchPayoutStore; chain: LaunchPayoutChain; payer: string; dailyCapLamports: string;
  // Sign-only, never submits. No recipient or buyback private keys are used.
  sign: (unsigned: string, signal: AbortSignal) => Promise<string>;
  signal: AbortSignal; execute: boolean;
  onFailure?: (failure: {stage: string; reason: string}) => void;
}) {
  deps.signal.throwIfAborted();
  const claim = await deps.store.claim(!deps.execute);
  if (!claim) return { outcome: "idle" as const };
  let outcome: PayoutOutcome = "retry";
  let stage = "reconcile";
  try {
    let attempt = claim.attempt;
    if (attempt) {
      const recovered = await deps.chain.reconcile(claim, attempt);
      if (recovered.kind === "confirmed" || recovered.kind === "failed") {
        await deps.store.settle(claim, attempt, recovered.kind === "confirmed" ? recovered.receipt : null);
        outcome = recovered.kind;
        return { outcome };
      }
      if (recovered.kind === "expired_unresolved") { outcome = recovered.kind; return { outcome }; }
      outcome = "pending";
    }
    if (!deps.execute || !claim.enabled) { outcome = attempt ? "pending" : "paused"; return { outcome }; }
    deps.signal.throwIfAborted();
    if (!attempt) {
      stage = "prepare";
      const plan = await deps.chain.prepare(claim);
      if (!plan) { outcome = "below_threshold"; return { outcome }; }
      stage = "validate";
      await verifyPayoutPlan(claim, deps.payer, plan);
      deps.signal.throwIfAborted();
      stage = "sign";
      const signed = await deps.sign(plan.unsigned, deps.signal);
      const signature = verifyPayoutSignature(plan, signed, deps.payer);
      attempt = { ...plan, id: randomUUID(), signed, signature, payer: deps.payer };
      // Persistence must succeed before ANY send. Late sign-only responses are
      // discarded on abort; they have never been exposed to a broadcaster.
      deps.signal.throwIfAborted();
      stage = "persist";
      if (!await deps.store.save(claim, attempt, deps.dailyCapLamports)) { outcome = "budget_exhausted"; return { outcome }; }
    }
    deps.signal.throwIfAborted();
    stage = "permission";
    if (!await deps.store.maySend(claim, attempt)) { outcome = "paused"; return { outcome }; }
    deps.signal.throwIfAborted();
    stage = "submit";
    const sent = await deps.chain.send(claim, attempt);
    outcome = sent === "sent" ? "submitted" : "expired_unresolved";
    return { outcome };
  } catch (error) {
    // A timeout after send is uncertain, not failed. The signed transaction is
    // already durable and the next owner reconciles or rebroadcasts SAME bytes.
    outcome = "retry";
    // Fixed codes only. Never log provider URLs, database errors or signed bytes.
    const message = error instanceof Error ? error.message : "";
    const known: Record<string,string> = {
      "Graduated payout acceptance required.": "graduated_not_accepted",
      "Payout simulation failed.": "simulation_failed",
      "Payout providers unavailable.": "rpc_unavailable",
      "Payout network fee unavailable or excessive.": "fee_unavailable",
      "Payout requires unapproved fee-payer funding.": "payer_funding_required",
      "Unexpected Pump account ownership.": "account_ownership",
      "Unsupported launch payout route.": "unsupported_route",
      "Invalid payout signature.": "invalid_signature",
      "Payout signature changed the reviewed transaction.": "signature_changed",
      "Only the registered Pump distribution instructions may be signed.": "instructions_changed",
      "Payout differs from the approved pilot.": "pilot_mismatch",
    };
    try { deps.onFailure?.({stage, reason: deps.signal.aborted ? "deadline" : known[message] || "unclassified"}); } catch { /* Diagnostics cannot affect recovery. */ }
    return { outcome };
  } finally {
    await deps.store.complete(claim, outcome);
  }
}
