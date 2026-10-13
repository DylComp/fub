import type { CopySigningAdapter } from "./copy-dispatch-worker.js";
import type { Rpc } from "./funding.js";
import { USDC } from "../src/funding-model.js";
import { copySigningGate } from "./copy-signing.js";
import { copyExecutionStore } from "./copy-execution-store.js";
import { classifyLeaderSwap } from "./copy-classifier.js";
import { MAINNET_GENESIS } from "./solana-network.js";
import { independentlyBudgetedSignature, isolatedSigningBudget } from "./isolated-signing-budget.js";
import type { PrivySignRequest } from "./privy-sign-only.js";
import { isolatedCopyInventory, type InventoryEvidence } from "./isolated-copy-inventory.js";
import { recoverIsolatedInventory } from "./isolated-inventory-recovery.js";
import { readCopyInventory } from "./copy-inventory.js";
import { verifyCopySwapMessageSignature } from "./copy-swap.js";
import type { EnrolledWallet } from "./signer-enrollment.js";

async function withinDeadline<T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([Promise.resolve().then(action), new Promise<never>((_, reject) => {
      abort = () => reject(Error("Signer request stopped or expired."));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

// Service-side composition only. No public route or executor imports provider
// secrets. Activation requires separately secured hosting, roles, binding setup
// and permission/revocation enrollment. Sells require independently settled buys.
export function isolatedCopySigner(options: {
  applicationReadUrl: string;
  privateBudgetUrl: string;
  rpc: Rpc;
  resolveWallet: (wallet: string, permissionIssuedAt: number, signal: AbortSignal) => Promise<EnrolledWallet>;
  provider: (request: PrivySignRequest, signal: AbortSignal) => Promise<string>;
}): CopySigningAdapter {
  const source = new URL(options.applicationReadUrl), privateDb = new URL(options.privateBudgetUrl);
  if (![source, privateDb].every(u => ["postgres:", "postgresql:"].includes(u.protocol)) ||
      (source.hostname === privateDb.hostname && source.pathname === privateDb.pathname) ||
      source.username === privateDb.username)
    throw Error("Signer needs separate databases and separate least-privilege roles.");
  const budget = isolatedSigningBudget(options.privateBudgetUrl);
  const inventory = isolatedCopyInventory(options.privateBudgetUrl);
  return async (request, signal) => {
    const r = structuredClone(request);
    if (!Number.isSafeInteger(r.expiresAt) || r.expiresAt <= Date.now() || r.expiresAt > Date.now() + 30000)
      throw Error("Invalid signer request deadline.");
    signal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(8000, r.expiresAt - Date.now()))]);
    signal.throwIfAborted();
    let calls = 0;
    // Each request has a bounded read/simulation budget and cannot broadcast.
    const rpc: Rpc = async (method, params) => {
      if (++calls > 48 || !["getGenesisHash", "getTransaction", "getBlockHeight", "getAccountInfo", "getMultipleAccounts", "getBalance", "getFeeForMessage", "getMinimumBalanceForRentExemption", "isBlockhashValid", "getLatestBlockhash", "getTokenAccountBalance", "simulateTransaction"].includes(method)) throw Error("Signer RPC operation refused.");
      return withinDeadline(() => options.rpc(method, params), signal);
    };
    const state = await withinDeadline(() => copyExecutionStore(options.applicationReadUrl, r.dispatch).signingAuthorization(r.wallet, r.attemptId), signal);
    const selling = state?.attempt.side === "sell";
    if (!state || (selling ? r.review.intent.outputMint !== USDC || !state.permission.scope.copySells : r.review.intent.inputMint !== USDC))
      throw Error("This signer requires authorized standard-token trades against USDC.");
    if (await rpc("getGenesisHash", []) !== MAINNET_GENESIS) throw Error("Signer requires verified Solana mainnet.");
    const receipt = await rpc("getTransaction", [state.attempt.leaderSignature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 1 }]) as { slot?: unknown; blockTime?: unknown } | null;
    const now = Math.floor(Date.now() / 1000);
    if (!receipt || !Number.isSafeInteger(receipt.slot) || !Number.isSafeInteger(receipt.blockTime) ||
        Number(receipt.blockTime) > now + 1 || now - Number(receipt.blockTime) > 60)
      throw Error("Leader receipt is missing or no longer fresh.");
    const decision = classifyLeaderSwap(receipt, state.permission.scope.leader, {
      signature: state.attempt.leaderSignature, slot: Number(receipt.slot), blockTime: Number(receipt.blockTime), failed: false,
    });
    if (decision.kind !== "swap" || decision.side !== (selling ? "sell" : "buy") || decision.mint !== state.attempt.mint ||
        decision.mint !== (selling ? r.review.intent.inputMint : r.review.intent.outputMint) || decision.tokenDecimals !== (selling ? state.attempt.inputDecimals : state.attempt.outputDecimals))
      throw Error("Leader receipt does not authorize this trade.");
    signal.throwIfAborted();
    const enrolled = await withinDeadline(() => options.resolveWallet(r.wallet, state.permission.scope.issuedAt, signal), signal);
    // Re-read permission, plan, lease and chain evidence AFTER leader discovery.
    const gate = copySigningGate({ url: options.applicationReadUrl, rpc, signer: async (verified, active) => {
      const evidence: InventoryEvidence = { request: verified, leaderSignature: state.attempt.leaderSignature, decimals: decision.tokenDecimals, createdAt: Date.now() };
      const provider = async () => {
        await withinDeadline(() => enrolled.check(active), active);
        const result = await options.provider({ walletId: enrolled.walletId, wallet: verified.wallet, unsigned: verified.review.unsigned,
          idempotencyKey: verified.idempotencyKey, expiresAt: verified.expiresAt }, active);
        // Save exact signed bytes even if a stop arrives during provider work.
        // The later owner/deadline checks still withhold the response.
        await inventory.complete(evidence, result);
        return result;
      };
      let signed: string;
      if (!selling) {
        signed = await independentlyBudgetedSignature({ request: verified, leaderSignature: state.attempt.leaderSignature, budget, signal: active,
          sign: async () => { await inventory.recordBuy(evidence); return provider(); },
        });
      } else {
        // A just-finalized buy need not wait for the background recovery tick.
        // Only this wallet/mint's latest four private signatures are considered.
        await recoverIsolatedInventory(inventory,rpc,active,{wallet:verified.wallet,mint:decision.mint});
        const minimumSlot = await inventory.minimumSlot(verified.wallet, decision.mint);
        const holdings = await readCopyInventory(verified.wallet, decision.mint, rpc, minimumSlot);
        active.throwIfAborted();
        const claim = await inventory.claimSell(evidence, decision, holdings);
        if (claim.kind === "signed") { signed = claim.signed; verifyCopySwapMessageSignature(verified.review,signed); }
        else {
          try { active.throwIfAborted(); if (verified.expiresAt<=Date.now()) throw Error(); signed = await provider(); }
          catch { await inventory.uncertain(evidence).catch(()=>{}); throw Error("Sell signing was not confirmed. Its tokens remain reserved."); }
        }
      }
      active.throwIfAborted();
      if (verified.expiresAt<=Date.now()) throw Error("Signing request expired.");
      // The private ledger retains a signature even if stop arrived in flight.
      // Cached signatures must pass this check too, and are never re-signed.
      await withinDeadline(() => enrolled.check(active), active);
      return signed;
    } });
    return gate(r, signal);
  };
}
