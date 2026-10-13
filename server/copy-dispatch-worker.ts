import { copyDispatchStore } from "./copy-dispatch-store.js";
import type { DispatchClaim } from "./copy-dispatch-store.js";
import { copyLedger } from "./copy-ledger.js";
import { copySellLedger } from "./copy-sell-ledger.js";
import { copyExecutionStore } from "./copy-execution-store.js";
import { copyExecution } from "./copy-execution.js";
import {
  copyIntentForAttempt,
  fetchCopyBuild,
  prepareCopyBuild,
} from "./copy-swap.js";
import type { ReviewedCopySwap } from "./copy-swap.js";
import { reviewCopyBuild } from "../src/copy-swap.js";
import type { CopySwapIntent } from "../src/copy-swap.js";
import { proportionalSell } from "../src/copy-account.js";
import { USDC, TOKEN_PROGRAM } from "../src/funding-model.js";
import type { Rpc } from "./funding.js";
import { copySigningGate, CopySigningSuperseded } from "./copy-signing.js";
import { journaledCopySigner, signingJournal } from "./copy-signing-journal.js";

export type CopySigningRequest = {
  wallet: string;
  dispatch: { id: string; leaseId: string };
  attemptId: string;
  idempotencyKey: string;
  permission: DispatchClaim["permission"];
  review: ReviewedCopySwap;
  expiresAt: number;
};
// A provider adapter must independently enforce owner policy and return signed
// bytes only. No sign-and-send provider, local private key or fake default signer.
export type CopySigningAdapter = (
  request: CopySigningRequest,
  signal: AbortSignal,
) => Promise<string>;
export type DispatchOptions = {
  url: string;
  rpc: Rpc;
  apiKey?: string;
  enabled?: boolean;
  signer?: CopySigningAdapter;
  fetchBuild?: typeof fetchCopyBuild;
  signal?: AbortSignal;
};
// Bounds waiting without retrying an RPC. A timed-out send may still land, so
// the engine persists its signature before calling this transport and recovers it.
export function boundedDispatchRpc(
  rpc: Rpc,
  deadline: number,
  signal?: AbortSignal,
): Rpc {
  return async (method, params) => {
    signal?.throwIfAborted();
    const duration = Math.min(5000, deadline - Date.now());
    if (duration < 1) throw new Error("Dispatch RPC window expired.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          signal?.throwIfAborted();
          return rpc(method, params);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Dispatch RPC timed out.")),
            duration,
          );
          if (signal) {
            onAbort = () => reject(new Error("Dispatch stopped."));
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          }
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  };
}
async function boundedSignature(
  signer: CopySigningAdapter,
  request: CopySigningRequest,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const duration = Math.min(8000, request.expiresAt - Date.now());
  if (duration < 1) throw new Error("Signing window expired.");
  const controller = new AbortController();
  const combined = AbortSignal.any([
    controller.signal,
    ...(signal ? [signal] : []),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        combined.throwIfAborted();
        return signer(request, combined);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Signer response timed out."));
        }, duration);
        if (signal) {
          onAbort = () => reject(new Error("Signing stopped."));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
export function dispatchIntent(
  claim: DispatchClaim,
  positionRaw: string,
  now = Date.now(),
): CopySwapIntent {
  const d = claim.decision,
    p = claim.permission.scope;
  if (
    d.kind !== "swap" ||
    !["buy", "sell"].includes(d.side) ||
    (d.tokenProgram || TOKEN_PROGRAM) !== TOKEN_PROGRAM ||
    !Number.isInteger(d.tokenDecimals) ||
    d.tokenDecimals < 0 ||
    d.tokenDecimals > 18 ||
    claim.blockTime * 1000 > now + 5000 ||
    now - claim.blockTime * 1000 >= 60000 ||
    (d.side === "sell" && !p.copySells)
  )
    throw new Error("Leader swap cannot be dispatched.");
  const selling = d.side === "sell";
  return {
    wallet: claim.wallet,
    inputMint: selling ? d.mint : USDC,
    outputMint: selling ? USDC : d.mint,
    inputRaw: selling
      ? proportionalSell(positionRaw, d.leaderTokenBeforeRaw, d.tokenRaw)
      : (BigInt(p.buyCents) * 10000n).toString(),
    // A quote-discovery floor only. Never saved or signed: the reviewed encoded
    // minimum replaces this before reservation and transaction preparation.
    minOutputRaw: "1",
    slippageBps: p.slippageBps,
    maxNetworkFeeLamports: p.maxNetworkFeeLamports,
    expiresAt: Math.min(
      now + 30000,
      claim.deadline,
      claim.leaseUntil,
      p.expiresAt,
    ),
  };
}
export async function runCopyDispatch(options: DispatchOptions) {
  // Both process opt-in and a separate database control are required. The gate
  // executes before any database, provider or signer work.
  if (options.enabled !== true || !options.signer || !options.apiKey)
    return { outcome: "disabled" as const };
  options.signal?.throwIfAborted();
  const store = copyDispatchStore(options.url);
  await store.discover();
  options.signal?.throwIfAborted();
  const claim = await store.claim();
  if (!claim) return { outcome: "idle" as const };
  const rpc = boundedDispatchRpc(
    options.rpc,
    Math.min(claim.deadline, claim.leaseUntil),
    options.signal,
  );
  const ledger = copyLedger(options.url, claim),
    executionStore = copyExecutionStore(options.url, claim),
    engine = copyExecution({
      url: options.url,
      rpc,
      apiKey: options.apiKey,
      allowSubmission: true,
      dispatch: claim,
      signal: options.signal,
    });
  try {
    options.signal?.throwIfAborted();
    const existing = await store.attempt(claim);
    let attempt = existing ? await ledger.get(claim.wallet, existing) : null;
    let build: unknown;
    if (!attempt) {
      const position =
        claim.decision.side === "sell"
          ? await ledger.position(
              claim.wallet,
              claim.planId,
              claim.decision.mint,
            )
          : "0";
      const intent = dispatchIntent(claim, position);
      if (intent.inputRaw === "0") {
        await store.complete(claim, "ineligible");
        return { outcome: "skipped" as const };
      }
      build = await (options.fetchBuild || fetchCopyBuild)(
        intent,
        options.apiKey,
        undefined,
        options.signal,
      );
      options.signal?.throwIfAborted();
      const quote = await reviewCopyBuild(build, intent);
      if (!(await store.current(claim)))
        return { outcome: "superseded" as const };
      options.signal?.throwIfAborted();
      const common = {
        signature: claim.signature,
        mint: claim.decision.mint,
        blockTime: claim.blockTime,
        planVersion: claim.planVersion,
        minOutputRaw: quote.minimum,
        slippageBps: intent.slippageBps,
        expiresAt: intent.expiresAt,
      };
      attempt =
        claim.decision.side === "sell"
          ? await copySellLedger(options.url, claim).reserveSell(
              claim.wallet,
              claim.planId,
              {
                ...common,
                inputRaw: intent.inputRaw,
                inputDecimals: claim.decision.tokenDecimals,
              },
              rpc,
            )
          : await ledger.reserveBuy(claim.wallet, claim.planId, {
              ...common,
              inputCents: claim.permission.scope.buyCents,
              outputDecimals: claim.decision.tokenDecimals,
            });
    }
    if (!attempt || attempt.state !== "reserved") {
      await store.complete(
        claim,
        attempt &&
          ["submitting", "unknown", "confirmed", "failed"].includes(
            attempt.state,
          )
          ? "submitted"
          : "ineligible",
      );
      return { outcome: "skipped" as const };
    }
    if (!attempt.prepared) {
      options.signal?.throwIfAborted();
      if (build) {
        const prepared = await prepareCopyBuild(
          build,
          copyIntentForAttempt(attempt),
          rpc,
        );
        if (
          prepared.preflight.input.decimals !==
            (attempt.side === "sell" ? attempt.inputDecimals : 6) ||
          prepared.preflight.output.decimals !== attempt.outputDecimals
        )
          throw new Error("Dispatch token precision changed.");
        attempt = await executionStore.savePrepared(
          claim.wallet,
          attempt.id,
          prepared.review,
        );
      } else attempt = await engine.prepare(claim.wallet, attempt.id);
    }
    if (
      !attempt?.prepared ||
      !(await store.current(claim)) ||
      !(await executionStore.authorized(claim.wallet, attempt.id))
    )
      return { outcome: "superseded" as const };
    const review = attempt.prepared.review;
    const signed = await boundedSignature(
      copySigningGate({
        url: options.url,
        rpc,
        signer: journaledCopySigner(
          signingJournal(options.url),
          options.signer,
        ),
      }),
      {
        wallet: claim.wallet,
        dispatch: { id: claim.id, leaseId: claim.leaseId },
        attemptId: attempt.id,
        idempotencyKey: `${attempt.id}:${review.messageHash}`,
        permission: claim.permission,
        review,
        expiresAt: Math.min(review.expiresAt, claim.leaseUntil, claim.deadline),
      },
      options.signal,
    );
    if (!(await store.current(claim)))
      return { outcome: "superseded" as const };
    options.signal?.throwIfAborted();
    const sent = await engine.submit(claim.wallet, attempt.id, signed);
    const submitted =
      !!sent &&
      ["submitting", "unknown", "confirmed", "failed"].includes(sent.state);
    await store.complete(claim, submitted ? "submitted" : "ineligible");
    return {
      outcome: submitted ? ("submitted" as const) : ("skipped" as const),
    };
  } catch (error) {
    if (error instanceof CopySigningSuperseded)
      return { outcome: "superseded" as const };
    // A send timeout has already been persisted as unknown by the execution
    // engine. complete() consults that durable state instead of retrying it.
    await store.complete(claim, "retry");
    return { outcome: "retry" as const };
  }
}

// Host-independent continuous runner. Production must supply a configured feed,
// RPC and policy-enforcing signer. Abort stops starting work; current claims still
// obey their deadline and durable submission/recovery rules.
export async function runCopyDispatchLoop(
  run: () => Promise<unknown>,
  signal: AbortSignal,
  delayMs = 1000,
) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 250 || delayMs > 30000)
    throw new Error("Invalid dispatch interval.");
  let failures = 0;
  while (!signal.aborted) {
    try {
      await run();
      failures = 0;
    } catch {
      failures = Math.min(failures + 1, 5);
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.min(30000, delayMs * 2 ** failures));
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
}
