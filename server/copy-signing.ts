import { isDeepStrictEqual } from "node:util";
import { isMint } from "../src/assets.js";
import { operationId } from "../src/funding-model.js";
import { copyExecutionStore } from "./copy-execution-store.js";
import { assertCopyPermissionAttempt } from "./copy-permission-model.js";
import {
  copyIntentForAttempt,
  preflightCopySwap,
  revalidateCopyReview,
  verifyCopySwapSignature,
} from "./copy-swap.js";
import type { CopySigningAdapter, CopySigningRequest } from "./copy-dispatch-worker.js";
import type { Rpc } from "./funding.js";

export class CopySigningSuperseded extends Error {
  constructor() { super("Copy signing permission or dispatch changed."); }
}

// Application-side gate. This has no signing key and is not a substitute for
// custody-provider policy or an independently deployed signing service.
export function copySigningGate(options: {
  url: string;
  rpc: Rpc;
  signer: CopySigningAdapter;
}): CopySigningAdapter {
  return async (request, signal) => {
    signal.throwIfAborted();
    const input = structuredClone(request);
    if (!isMint(input.wallet) || !operationId(input.attemptId) ||
      !input.dispatch || !operationId(input.dispatch.id) ||
      !operationId(input.dispatch.leaseId) ||
      !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now())
      throw new Error("Invalid copy signing request.");
    const store = copyExecutionStore(options.url, input.dispatch);
    const current = async () => {
      signal.throwIfAborted();
      const state = await store.signingAuthorization(input.wallet, input.attemptId);
      const attempt = state?.attempt;
      if (!attempt?.prepared || !state?.dispatch ||
        state.dispatch.id !== input.dispatch.id || state.dispatch.leaseId !== input.dispatch.leaseId ||
        !isDeepStrictEqual(input.permission, state.permission) ||
        !isDeepStrictEqual(input.review, attempt.prepared.review) ||
        input.idempotencyKey !== `${attempt.id}:${attempt.prepared.review.messageHash}` ||
        input.expiresAt > Math.min(attempt.expiresAt, state.dispatch.deadline, state.dispatch.leaseUntil))
        throw new CopySigningSuperseded();
      assertCopyPermissionAttempt(state.permission.scope, attempt);
      signal.throwIfAborted();
      if (input.expiresAt <= Date.now()) throw new CopySigningSuperseded();
      return state;
    };
    const { permission, attempt } = await current();
    const review = await revalidateCopyReview(
      attempt.prepared!.review, copyIntentForAttempt(attempt), options.rpc,
    );
    signal.throwIfAborted();
    await preflightCopySwap(review, options.rpc, attempt.inventorySlot || 0);
    // A stop or edit while the RPC work was running must prevent provider access.
    await current();
    const verified: CopySigningRequest = {
      wallet: attempt.wallet,
      attemptId: attempt.id,
      idempotencyKey: input.idempotencyKey,
      dispatch: { ...input.dispatch },
      permission: structuredClone(permission),
      review,
      expiresAt: input.expiresAt,
    };
    // Keep our evidence separate from an adapter's mutable request object.
    const signed = await options.signer(structuredClone(verified), signal);
    signal.throwIfAborted();
    verifyCopySwapSignature(review, signed);
    await current();
    return signed;
  };
}
