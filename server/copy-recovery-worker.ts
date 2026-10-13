import { blockRecoveryRpc } from "./copy-block-recovery.js";
import { copyRecoveryStore } from "./copy-recovery-store.js";
import { copyExecution } from "./copy-execution.js";
import { copyReadRpc, reserveCopyScan } from "./copy-rpc.js";
import type { CopyAttempt } from "./copy-ledger.js";
import type { Rpc } from "./funding.js";
import type { RecoveryOutcome } from "./copy-recovery-store.js";
import { runToken22Recovery } from "./token2022-recovery-worker.js";

export async function runCopyRecovery(
  deps: {
    store: ReturnType<typeof copyRecoveryStore>;
    reserve: () => Promise<boolean>;
    rpc: () => Rpc;
    recover: (
      wallet: string,
      id: string,
      rpc: Rpc,
    ) => Promise<CopyAttempt | null>;
    now?: () => number;
    recoverToken22?: () => Promise<{ outcome: string; handled: boolean }>;
    preferToken22?: boolean;
  } = {
    store: copyRecoveryStore(process.env.DATABASE_URL!),
    reserve: () => reserveCopyScan(process.env.DATABASE_URL!),
    rpc: copyReadRpc,
    recoverToken22: runToken22Recovery,
    // This service instance has no submission permission or API key.
    recover: (wallet, id, rpc) =>
      copyExecution({
        url: process.env.DATABASE_URL!,
        rpc,
        blockRecoveryRpc: blockRecoveryRpc(),
      }).recover(wallet, id),
  },
) {
  const lease = await deps.store.beginWorker();
  if (!lease) return { outcome: "busy", handled: true, expired: 0 };
  let outcome = "idle",
    expired = 0;
  const now = deps.now || Date.now,
    started = now(),
    deadline = started + 15000;
  try {
    // Alternate on continuous hosts so a busy standard queue cannot starve
    // native settlement. Both paths remain inside the same worker lease.
    if (deps.preferToken22 && deps.recoverToken22) {
      const native = await deps.recoverToken22();
      if (native.handled || now() >= deadline) {
        outcome = native.outcome;
        return { outcome, handled: true, expired };
      }
    }
    const unsent = await deps.store.expired();
    for (const attempt of unsent) {
      if (now() >= deadline) {
        outcome = "busy";
        return { outcome, handled: true, expired };
      }
      if (await deps.store.expire(attempt.wallet, attempt.id)) expired++;
    }
    if (unsent.length || now() >= deadline) {
      outcome = unsent.length ? "expired" : "busy";
      return { outcome, handled: true, expired };
    }
    const claim = await deps.store.claim();
    if (!claim) {
      if (!deps.preferToken22 && deps.recoverToken22 && now() < deadline) {
        const token22 = await deps.recoverToken22();
        outcome = token22.outcome;
        return {
          outcome,
          handled: token22.handled || now() - started > 5000,
          expired,
        };
      }
      return { outcome, handled: now() - started > 5000, expired };
    }
    let result: RecoveryOutcome = "retry";
    try {
      if (!(await deps.reserve())) result = "busy";
      else {
        const attempt = await deps.recover(
          claim.wallet,
          claim.attemptId,
          deps.rpc(),
        );
        result =
          attempt?.state === "confirmed" || attempt?.state === "failed"
            ? attempt.state
            : "unknown";
      }
    } catch {
      result = "retry";
    }
    outcome = result;
    await deps.store.complete(claim, result);
    return { outcome, handled: true, expired };
  } catch (error) {
    outcome = "retry";
    throw error;
  } finally {
    await deps.store.endWorker(lease, outcome);
  }
}
