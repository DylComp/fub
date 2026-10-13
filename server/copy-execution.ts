import {
  recoverFromFinalizedBlock,
  RecoveryMismatch,
} from "./copy-block-recovery.js";
import type { CopyRecoveryEvidence } from "../src/copy-recovery-evidence.js";
import type { DispatchTicket } from "./copy-dispatch-store.js";
import { copyLedger } from "./copy-ledger.js";
import { copySellLedger } from "./copy-sell-ledger.js";
import { copyExecutionStore } from "./copy-execution-store.js";
import { verifyCopyLanded } from "./copy-outcome.js";
import {
  prepareReservedCopySwap,
  preflightCopySwap,
  verifyCopySwapSignature,
} from "./copy-swap.js";
import type { Rpc } from "./funding.js";

// Wallet-signed submission plumbing only. No autonomous signer or public send
// endpoint exists. Recovery is independent of this disabled-by-default gate.
export function copyExecution(options: {
  url: string;
  rpc: Rpc;
  apiKey?: string;
  allowSubmission?: boolean;
  dispatch?: DispatchTicket;
  blockRecoveryRpc?: Rpc;
  signal?: AbortSignal;
}) {
  const { url, rpc } = options,
    ledger = copyLedger(url),
    store = copyExecutionStore(url, options.dispatch);
  const requireEnabled = () => {
    options.signal?.throwIfAborted();
    if (options.allowSubmission !== true)
      throw new Error("Copy submission is disabled.");
  };
  return {
    async prepare(wallet: string, id: string) {
      requireEnabled();
      const attempt = await store.authorized(wallet, id);
      if (!attempt || attempt.state !== "reserved") return null;
      const prepared = await prepareReservedCopySwap(
        attempt,
        rpc,
        options.apiKey || "",
        options.signal,
      );
      options.signal?.throwIfAborted();
      return store.savePrepared(wallet, id, prepared.review);
    },
    async submit(wallet: string, id: string, signed: string) {
      requireEnabled();
      const attempt = await ledger.get(wallet, id);
      if (!attempt || attempt.state !== "reserved") return attempt;
      const review = attempt.prepared?.review;
      if (!review) throw new Error("Prepare this copy trade before signing.");
      verifyCopySwapSignature(review, signed);
      const preflight = await preflightCopySwap(
        review,
        rpc,
        attempt.inventorySlot || 0,
      );
      options.signal?.throwIfAborted();
      const claimed = await store.claim(wallet, id, signed, preflight);
      if (!claimed) return ledger.get(wallet, id);
      // Only the winner of the durable claim gets here. A crash after claiming
      // leaves the wallet locked; retries must recover this exact signature.
      try {
        verifyCopySwapSignature(review, signed);
        const returned = await rpc("sendTransaction", [
          signed,
          {
            encoding: "base64",
            skipPreflight: false,
            preflightCommitment: "confirmed",
            maxRetries: 0,
            minContextSlot: claimed.execution!.minContextSlot,
          },
        ]);
        if (returned !== claimed.signature)
          throw new Error("RPC returned a different transaction signature.");
        return claimed; // Acceptance is not confirmation.
      } catch {
        return ledger.markUnknown(wallet, id);
      }
    },
    async recover(wallet: string, id: string) {
      const attempt = await ledger.get(wallet, id);
      if (!attempt || !["submitting", "unknown"].includes(attempt.state))
        return attempt;
      if (!attempt.execution || !attempt.prepared)
        throw new Error(
          "Copy execution evidence is unavailable. The trade remains locked.",
        );
      let evidence: CopyRecoveryEvidence = {
        kind: "provider_unavailable",
        checkedAt: Date.now(),
      };
      try {
        let reply: unknown;
        try {
          reply = await rpc("getTransaction", [
            attempt.signature,
            {
              encoding: "base64",
              commitment: "finalized",
              maxSupportedTransactionVersion: 0,
            },
          ]);
        } catch (error) {
          if (!options.blockRecoveryRpc) throw error;
          reply = null;
        }
        if (reply === null) {
          if (options.blockRecoveryRpc) {
            const recovered = await recoverFromFinalizedBlock(
              attempt,
              options.blockRecoveryRpc,
            );
            evidence = recovered.evidence;
            reply = recovered.reply;
          } else evidence = { kind: "not_indexed", checkedAt: Date.now() };
          if (reply === null) {
            await ledger.noteRecovery(attempt, evidence);
            return ledger.markUnknown(wallet, id);
          }
        }
        const source =
          evidence.kind === "block_receipt"
            ? "block_receipt"
            : "indexed_receipt";
        evidence = { kind: "inconsistent", checkedAt: Date.now() };
        const outcome = verifyCopyLanded(attempt, reply);
        evidence = {
          kind: source,
          checkedAt: Date.now(),
          slot: (reply as { slot: number }).slot,
        };
        await ledger.noteRecovery(attempt, evidence);
        if (outcome.kind === "failed")
          return store.settleFailure(wallet, id, outcome);
        const readFinalized: Rpc = async () => reply;
        return attempt.side === "sell"
          ? copySellLedger(url).confirmSell(wallet, id, readFinalized)
          : ledger.confirmBuy(wallet, id, readFinalized);
      } catch (error) {
        if (error instanceof RecoveryMismatch)
          evidence = { kind: "inconsistent", checkedAt: Date.now() };
        await ledger.noteRecovery(attempt, evidence);
        await ledger.markUnknown(wallet, id);
        throw new Error(
          "The trade could not be verified. Its reservation remains locked.",
        );
      }
    },
  };
}
