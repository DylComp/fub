import { token22Journal } from "./token2022-journal.js";
import { copyReadRpc, reserveCopyScan } from "./copy-rpc.js";
import type { Rpc } from "./funding.js";
import { token22Accounting } from "./token2022-accounting.js";

// Called within the existing authenticated recovery service. Only signed journal
// rows are discoverable. It cannot prepare a trade, call a signer, or broadcast.
export async function runToken22Recovery(
  deps: {
    store: Pick<
      ReturnType<typeof token22Journal>,
      "claimRecovery" | "defer" | "recover"
    >;
    reserve: () => Promise<boolean>;
    rpc: () => Rpc;
    reconcile?: () => Promise<"applied" | "deferred" | null>;
  } = {
    store: token22Journal(process.env.DATABASE_URL!),
    reserve: () => reserveCopyScan(process.env.DATABASE_URL!),
    rpc: copyReadRpc,
    reconcile: () => token22Accounting(process.env.DATABASE_URL!).reconcile(),
  },
) {
  const accounting = await deps.reconcile?.();
  if (accounting)
    return { outcome: `token22-accounting-${accounting}`, handled: true };
  const claim = await deps.store.claimRecovery();
  if (!claim) return { outcome: "idle", handled: false };
  if (!(await deps.reserve())) {
    const saved = await deps.store.defer(claim, "busy");
    return { outcome: saved ? "token22-busy" : "token22-stale", handled: true };
  }
  const result = await deps.store.recover(claim, deps.rpc());
  return { outcome: `token22-${result.kind}`, handled: true };
}
