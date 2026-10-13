import { token22Queue } from "./token2022-queue.js";
import { runNativePreparation } from "./token2022-prepare-worker.js";
import { runToken22Dispatch } from "./token2022-dispatch.js";
import type { Token22DispatchOptions } from "./token2022-dispatch.js";

// One bounded unit of work. Preparation and execution use separate iterations,
// preserving the host's RPC/deadline budget and making restart handoff explicit.
export async function runNativeExecutor(
  options: Token22DispatchOptions & { apiKey?: string },
  deps = {
    queue: token22Queue,
    prepare: runNativePreparation,
    dispatch: runToken22Dispatch,
  },
) {
  if (!options.enabled || !options.signer || !options.apiKey)
    return { outcome: "disabled" as const };
  options.signal?.throwIfAborted();
  const queue = deps.queue(options.url),
    ticket = await queue.claimDispatch();
  if (!ticket) {
    const result = await deps.prepare(options);
    if (result.outcome === "ineligible") return { outcome: "skipped" as const };
    return result;
  }
  try {
    options.signal?.throwIfAborted();
    const result = await deps.dispatch(options, ticket);
    switch (result.outcome) {
      case "accepted":
        return { outcome: "submitted" as const };
      case "uncertain":
      case "already-claimed":
      case "signature-saved":
      case "awaiting-signature":
      case "accounting-pending":
        return { outcome: "recovering" as const };
      case "disabled":
        return result;
      default:
        return { outcome: "skipped" as const };
    }
  } finally {
    // No journal/review rewrite or automatic signature retry. A lost release
    // response simply leaves a scheduling lease to expire.
    await queue.releaseDispatch(ticket);
  }
}
