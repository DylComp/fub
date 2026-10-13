import { buybackId, verifyBuybackSigned } from "./buyback-model.js";
import { verifyBuybackPlan } from "./buyback-chain.js";
import type { BuybackAttempt } from "./buyback-model.js";
import type { buybackChain } from "./buyback-chain.js";
import type { buybackStore } from "./buyback-store.js";
export async function runBuyback(deps: {
  store: ReturnType<typeof buybackStore>;
  chain: ReturnType<typeof buybackChain>;
  execute: boolean;
  onFailure?: (failure: {stage:string;reason:string})=>void;
  signal: AbortSignal;
  sign: (unsigned: string, signal: AbortSignal) => Promise<string>;
}) {
  deps.signal.throwIfAborted();
  const claim = await deps.store.claim(!deps.execute);
  if (!claim) return { outcome: "idle" };
  let outcome = "retry", stage = "reconcile";
  try {
    let attempt = claim.attempt;
    if (attempt) {
      const recovered = await deps.chain.reconcile(attempt);
      if (recovered.kind === "settled") {
        await deps.store.settle(claim, attempt, recovered.receipt);
        outcome = recovered.receipt.success ? "confirmed" : "failed";
        return { outcome };
      }
      if (recovered.kind === "expired_unresolved") {
        outcome = recovered.kind;
        return { outcome };
      }
    }
    if (!deps.execute || !claim.enabled) {
      outcome = attempt ? "pending" : "paused";
      return { outcome };
    }
    deps.signal.throwIfAborted();
    if (!attempt) {
      stage = "prepare";
      const plan = await deps.chain.prepare(claim.available);
      if (!plan) {
        outcome = "below_threshold";
        return { outcome };
      }
      await verifyBuybackPlan(plan);
      if (
        Date.now() - plan.preparedAt > 30000 ||
        plan.preparedAt > Date.now() + 1000
      )
        throw Error("Fresh buyback preparation required");
      deps.signal.throwIfAborted();
      stage = "sign";
      const signed = await deps.sign(plan.unsigned, deps.signal);
      deps.signal.throwIfAborted();
      attempt = {
        id: buybackId(plan),
        plan,
        signed,
        signature: verifyBuybackSigned(plan, signed),
      } satisfies BuybackAttempt;
      stage = "persist";
      if (!(await deps.store.save(claim, attempt))) {
        outcome = "budget_exhausted";
        return { outcome };
      }
    }
    deps.signal.throwIfAborted();
    stage = "permission";
    if (!(await deps.store.maySend(claim, attempt))) {
      outcome = "paused";
      return { outcome };
    }
    deps.signal.throwIfAborted();
    stage = "submit";
    outcome =
      (await deps.chain.send(attempt)) === "sent"
        ? "submitted"
        : "expired_unresolved";
    return { outcome };
  } catch (error) {
    const message=error instanceof Error?error.message:'';
    const reasons:Record<string,string>={
      'Atomic buy-and-burn simulation failed':'simulation_failed',
      'The treasury token account must be provisioned before activation':'setup_required',
      'Treasury balance does not cover its receipt budget':'insufficient_balance',
      'Payout providers unavailable.':'rpc_unavailable',
      'Buyback exceeded approved spending':'receipt_budget_mismatch',
      'Fresh buyback preparation required':'stale_plan',
    };
    try{deps.onFailure?.({stage,reason:deps.signal.aborted?'deadline':reasons[message]||'unclassified'});}catch{/* Diagnostics never alter settlement. */}
    outcome = "retry";
    return { outcome };
  } finally {
    await deps.store.complete(claim, outcome);
  }
}
