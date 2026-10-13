import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { isMint } from "../src/assets.js";
import { orderId, record } from "../src/live-orders.js";
import { operationId, parsePlan, TOKEN_PROGRAM } from "../src/funding-model.js";
import type { FundingOperation, TransferReview } from "../src/funding-model.js";
import {
  associated,
  fromBase64,
  inspectTransfer,
  verifySignedTransfer,
  ATA_PROGRAM,
} from "../src/transaction-review.js";
import {
  resolveFundingLookups,
  revalidateFundingLookups,
} from "./funding-lookups.js";
import { fundingReceipt } from "./funding-receipt.js";
import type { FundingStore } from "./funding-store.js";
export type Provider = (
  path: string,
  body?: unknown,
  method?: string,
) => Promise<Record<string, unknown>>;
export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
export class ChainRpcError extends Error {
  constructor(readonly code: number) { super("Chain verification unavailable."); }
}
export async function rpcRequest(
  method: string,
  params: unknown[],
  endpoint = process.env.SOLANA_RPC_URL,
): Promise<unknown> {
  if (!endpoint) throw new Error("The execution RPC is not configured.");
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  if (!response.ok || text.length > 1000000)
    throw new Error("Chain verification unavailable.");
  const body = record(JSON.parse(text));
  if (body.error && Number.isSafeInteger(record(body.error).code))
    throw new ChainRpcError(Number(record(body.error).code));
  if (body.error || !("result" in body))
    throw new Error("Chain verification unavailable.");
  return body.result;
}
export async function tokenInfo(mint: string, rpc: Rpc) {
  const value = record(
    record(
      await rpc("getAccountInfo", [
        mint,
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]),
    ).value,
  );
  const parsed = record(record(value.data).parsed),
    info = record(parsed.info);
  if (
    value.owner !== TOKEN_PROGRAM ||
    parsed.type !== "mint" ||
    info.isInitialized !== true ||
    !Number.isInteger(info.decimals) ||
    (info.decimals as number) < 0 ||
    (info.decimals as number) > 18
  )
    throw new Error(
      "Only initialized standard SPL tokens are supported for funding. Token 2022 is not supported yet.",
    );
  return { mint, decimals: info.decimals as number };
}
async function vault(provider: Provider) {
  let data: Record<string, unknown>;
  try {
    data = await provider("/vault");
  } catch (error) {
    if ((error as { upstreamStatus?: number }).upstreamStatus !== 404)
      throw error;
    try {
      data = await provider("/vault/register");
    } catch (error) {
      if ((error as { upstreamStatus?: number }).upstreamStatus !== 409)
        throw error;
      data = await provider("/vault");
    }
  }
  if (typeof data.vaultPubkey !== "string" || !isMint(data.vaultPubkey))
    throw new Error("The vault address could not be verified.");
  return data;
}
async function findOrder(provider: Provider, wallet: string, id: string) {
  // Search is bounded; never infer ownership from the browser's cached order.
  for (let offset = 0; offset < 500; offset += 100) {
    const data = await provider(
      `/orders/history?limit=100&offset=${offset}&sort=updated_at&dir=desc`,
    );
    if (!Array.isArray(data.orders))
      throw new Error("Order history unavailable.");
    const found = data.orders.map(record).find((row) => row.id === id);
    if (found) {
      if (found.userPubkey !== wallet) throw new Error("Order owner mismatch.");
      return found;
    }
    if (data.orders.length < 100) break;
  }
  throw new Error(
    "Order not found in recent Jupiter history. Manage older orders in Jupiter.",
  );
}
async function costs(
  transaction: string,
  review: Omit<TransferReview, "feeLamports" | "rentLamports">,
  rpc: Rpc,
) {
  const tx = getTransactionDecoder().decode(fromBase64(transaction)),
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (message.version === 1)
    throw new Error("Unsupported transaction version.");
  const lookupTables = await resolveFundingLookups(message, rpc);
  const accountCreations =
    message.instructions.filter(
      (instruction) =>
        String(message.staticAccounts[instruction.programAddressIndex]) ===
        ATA_PROGRAM,
    ).length + (review.depositAccount ? 1 : 0);
  let rentEach = 0;
  if (accountCreations) {
    const quoted = await rpc("getMinimumBalanceForRentExemption", [
      165,
      { commitment: "confirmed" },
    ]);
    if (
      !Number.isSafeInteger(quoted) ||
      (quoted as number) <= 0 ||
      (quoted as number) > 2500000
    )
      throw new Error("Token account rent could not be verified.");
    rentEach = quoted as number;
  }
  const rent = accountCreations * rentEach;
  const fee = record(
    await rpc("getFeeForMessage", [
      btoa(String.fromCharCode(...tx.messageBytes)),
      { commitment: "confirmed" },
    ]),
  ).value;
  if (
    !Number.isSafeInteger(fee) ||
    (fee as number) < 0 ||
    (fee as number) > 5000000
  )
    throw new Error("Network fee could not be verified or exceeds 0.005 SOL.");
  const complete: TransferReview = {
    ...review,
    ...(lookupTables.length ? { lookupTables } : {}),
    feeLamports: String(fee),
    rentLamports: String(rent),
    ...(accountCreations ? { tokenAccountRentLamports: String(rentEach) } : {}),
  };
  await inspectTransfer(transaction, complete);
  const valid = record(
    await rpc("isBlockhashValid", [
      message.lifetimeToken,
      { commitment: "confirmed" },
    ]),
  ).value;
  if (valid !== true)
    throw new Error(
      "Transaction expired before review. Prepare a new request.",
    );
  const balance = record(
    await rpc("getBalance", [review.wallet, { commitment: "confirmed" }]),
  ).value;
  if (
    !Number.isSafeInteger(balance) ||
    BigInt(balance as number) < BigInt(fee as number) + BigInt(rent)
  )
    throw new Error(
      "The wallet needs more SOL for network fees and token-account rent.",
    );
  const simulation = record(
    record(
      await rpc("simulateTransaction", [
        transaction,
        {
          encoding: "base64",
          sigVerify: false,
          replaceRecentBlockhash: false,
          commitment: "confirmed",
        },
      ]),
    ).value,
  );
  if (simulation.err !== null)
    throw new Error(
      "Transaction simulation failed. No signature was requested.",
    );
  return complete;
}
export function createFundingService(
  store: FundingStore,
  provider: Provider,
  rpc: Rpc,
) {
  async function prepare(
    wallet: string,
    body: Record<string, unknown>,
  ): Promise<FundingOperation> {
    if (
      !operationId(body.id) ||
      (body.kind !== "create" && body.kind !== "cancel")
    )
      throw new Error("Invalid funding request.");
    const existing = await store.get(wallet, body.id);
    if (existing) return existing; // Stable request IDs never generate a second deposit/cancel.
    const plan = body.kind === "create" ? parsePlan(body.plan) : undefined;
    if (body.kind === "cancel" && !orderId(body.orderId))
      throw new Error("Choose an order to cancel.");
    const operation: FundingOperation = {
      id: body.id,
      wallet,
      kind: body.kind,
      state: "preparing",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(plan ? { plan } : { orderId: body.orderId as string }),
    };
    const inserted = await store.insert(operation);
    if (!inserted.inserted) return inserted.operation;
    let cancellationStarted = false;
    try {
      const vaultData = await vault(provider);
      if (vaultData.userPubkey !== wallet)
        throw new Error("Vault owner mismatch.");
      const vaultAddress = vaultData.vaultPubkey as string;
      let mint: string, amount: string, decimals: number;
      let deposit: Record<string, unknown>;
      if (plan) {
        const [input] = await Promise.all([
          tokenInfo(plan.inputMint, rpc),
          tokenInfo(plan.outputMint, rpc),
        ]);
        mint = plan.inputMint;
        amount = plan.inputAmount;
        decimals = input.decimals;
        const ata = await associated(wallet, mint);
        const balance = record(
          record(
            await rpc("getTokenAccountBalance", [
              ata,
              { commitment: "confirmed" },
            ]),
          ).value,
        );
        if (
          typeof balance.amount !== "string" ||
          !/^\d{1,20}$/.test(balance.amount) ||
          BigInt(balance.amount) < BigInt(amount) ||
          balance.decimals !== decimals
        )
          throw new Error(
            "The associated token account does not have enough tokens.",
          );
        deposit = await provider("/deposit/craft", {
          inputMint: mint,
          outputMint: plan.outputMint,
          userAddress: wallet,
          amount,
          orderType: "price",
          orderSubType: plan.orderType,
        });
        if (
          deposit.receiverAddress !== vaultAddress ||
          deposit.mint !== mint ||
          deposit.amount !== amount ||
          deposit.tokenDecimals !== decimals
        )
          throw new Error("The deposit response did not match the order.");
      } else {
        const order = await findOrder(provider, wallet, operation.orderId!);
        if (
          !["open", "expired", "pending_withdraw"].includes(
            String(order.orderState),
          ) ||
          typeof order.inputMint !== "string" ||
          typeof order.remainingInputAmount !== "string" ||
          !/^[1-9]\d{0,19}$/.test(order.remainingInputAmount)
        )
          throw new Error(
            "This order cannot be withdrawn here. Check its state in Jupiter.",
          );
        mint = order.inputMint;
        amount = order.remainingInputAmount;
        decimals = (await tokenInfo(mint, rpc)).decimals;
        cancellationStarted = true;
        deposit = await provider(
          `/orders/price/cancel/${operation.orderId}`,
          undefined,
          "POST",
        );
        if (deposit.id !== operation.orderId)
          throw new Error("Cancellation could not be matched to the order.");
      }
      if (
        typeof deposit.transaction !== "string" ||
        !orderId(deposit.requestId)
      )
        throw new Error("Invalid transaction response.");
      const review = await costs(
        deposit.transaction,
        {
          wallet,
          vault: vaultAddress,
          mint,
          amount,
          decimals,
          direction: plan ? "deposit" : "withdrawal",
          ...(plan && typeof deposit.inputTokenAccount === "string"
            ? {
                depositAccount: deposit.inputTokenAccount,
                outputMint: plan.outputMint,
              }
            : {}),
        },
        rpc,
      );
      const prepared = await store.update(wallet, operation.id, ["preparing"], {
        state: "prepared",
        requestId: deposit.requestId,
        transaction: deposit.transaction,
        review,
        expiresAt: Date.now() + 90000,
      });
      if (!prepared)
        throw new Error("Funding request changed. Reload its recovery record.");
      return prepared;
    } catch (error) {
      const message = cancellationStarted
        ? "Cancellation may have stopped the order. Funds have not been confirmed returned. Check Jupiter before continuing."
        : error instanceof Error
          ? error.message
          : "Could not prepare the order.";
      const updated = await store.update(wallet, operation.id, ["preparing"], {
        state: cancellationStarted ? "unknown" : "failed",
        message,
      });
      if (!updated) throw error;
      return updated;
    }
  }
  async function submit(
    wallet: string,
    id: string,
    signed: string,
  ): Promise<FundingOperation> {
    const operation = await store.get(wallet, id);
    if (!operation) throw new Error("Funding request not found.");
    if (operation.state !== "prepared") return operation;
    if (
      !operation.transaction ||
      !operation.review ||
      !operation.requestId ||
      (operation.expiresAt || 0) <= Date.now()
    )
      throw new Error(
        "This transaction review expired. Check recovery before preparing another.",
      );
    if (operation.plan) parsePlan(operation.plan);
    const signature = await verifySignedTransfer(
      operation.transaction,
      signed,
      operation.review,
    );
    const tx = getTransactionDecoder().decode(fromBase64(signed));
    const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    );
    if (
      record(
        await rpc("isBlockhashValid", [
          message.lifetimeToken,
          { commitment: "confirmed" },
        ]),
      ).value !== true
    )
      throw new Error("The transaction expired. No submission was made.");
    await revalidateFundingLookups(message, operation.review.lookupTables, rpc);
    // Commit the claim BEFORE sending money. Other instances observe this state and
    // cannot repeat the call, including after a process crash or unknown response.
    const claimed = await store.update(wallet, id, ["prepared"], {
      state: "submitting",
      signature,
    });
    if (!claimed) return (await store.get(wallet, id))!;
    try {
      const data =
        operation.kind === "create"
          ? await provider("/orders/price", {
              ...operation.plan,
              userPubkey: wallet,
              depositRequestId: operation.requestId,
              depositSignedTx: signed,
            })
          : await provider(
              `/orders/price/confirm-cancel/${operation.orderId}`,
              {
                cancelRequestId: operation.requestId,
                signedTransaction: signed,
              },
            );
      if (
        !orderId(data.id) ||
        data.txSignature !== signature ||
        (operation.kind === "cancel" && data.id !== operation.orderId) ||
        (operation.kind === "create" &&
          typeof data.depositConfirmed !== "boolean")
      )
        throw new Error("Unrecognized submission response.");
      const result = {
        id: data.id,
        txSignature: signature,
        ...(operation.kind === "create"
          ? { depositConfirmed: data.depositConfirmed as boolean }
          : {}),
      };
      return (await store.update(wallet, id, ["submitting"], {
        state: "submitted",
        result,
        orderId: data.id,
        message:
          "Submitted. Checking provider history and chain confirmation is still required.",
      }))!;
    } catch {
      return (await store.update(wallet, id, ["submitting"], {
        state: "unknown",
        message:
          "The submission result is unknown. Do not prepare another deposit. Refresh recovery and check Jupiter.",
      }))!;
    }
  }
  async function reconcile(
    wallet: string,
    id: string,
  ): Promise<FundingOperation> {
    const operation = await store.get(wallet, id);
    if (!operation) throw new Error("Funding request not found.");
    if (
      operation.state === "preparing" &&
      Date.now() - operation.createdAt > 120000
    ) {
      // No submission can start before a prepared transaction is persisted.
      return (
        (await store.update(wallet, id, ["preparing"], {
          state: operation.kind === "create" ? "failed" : "unknown",
          message:
            operation.kind === "create"
              ? "Preparation was interrupted before any deposit submission. You can start a new request."
              : "Cancellation preparation was interrupted. Check the order and vault in Jupiter.",
        })) || operation
      );
    }
    if (!["unknown", "submitting", "submitted"].includes(operation.state))
      return operation;
    if (!operation.signature) {
      // A historical withdrawal event is not proof that this cancellation returned
      // its remainder. Never unlock this request using an unrelated old signature.
      return operation;
    }
    const data = record(
      await rpc("getSignatureStatuses", [
        [operation.signature],
        { searchTransactionHistory: true },
      ]),
    );
    const status = Array.isArray(data.value) ? data.value[0] : null;
    if (!status) return operation; // Missing RPC history is not proof of failure.
    const chain = record(status);
    if (!["confirmed", "finalized"].includes(String(chain.confirmationStatus)))
      return operation;
    if (
      !Object.hasOwn(chain, "err") ||
      !(
        chain.err === null ||
        (typeof chain.err === "object" && !Array.isArray(chain.err)) ||
        (typeof chain.err === "string" && chain.err.length > 0)
      )
    )
      return operation;
    if (chain.err !== null)
      return (
        (await store.update(
          wallet,
          id,
          ["unknown", "submitting", "submitted"],
          {
            state: "failed",
            message:
              "The transaction failed on chain. No token transfer completed; network fees may still apply.",
          },
        )) || operation
      );
    for (let offset = 0; offset < 500; offset += 100) {
      const history = await provider(
        `/orders/history?limit=100&offset=${offset}&sort=updated_at&dir=desc`,
      );
      if (!Array.isArray(history.orders))
        throw new Error("Provider history unavailable.");
      const match = history.orders.map(record).find(
        (order) =>
          order.userPubkey === wallet &&
          Array.isArray(order.events) &&
          order.events.some((event) => {
            const value = record(event);
            return (
              value.txSignature === operation.signature &&
              value.state === "success" &&
              value.type ===
                (operation.kind === "create" ? "deposit" : "withdrawal")
            );
          }),
      );
      if (
        match &&
        orderId(match.id) &&
        (operation.kind === "create" || match.id === operation.orderId)
      ) {
        let receipt;
        try {
          receipt = await fundingReceipt(operation, rpc);
        } catch {
          /* Keep the wallet locked if RPC evidence is missing or mismatched. */
        }
        if (!receipt)
          return (
            (await store.update(
              wallet,
              id,
              ["unknown", "submitting", "submitted"],
              {
                message:
                  "The signature was found, but the landed transfer has not been verified against your review. Recovery remains open; do not deposit again.",
              },
            )) || operation
          );
        return (
          (await store.update(
            wallet,
            id,
            ["unknown", "submitting", "submitted"],
            {
              state: "confirmed",
              receipt,
              orderId: match.id,
              message:
                operation.kind === "create"
                  ? "Deposit confirmed and matched to Jupiter's order history. Check the live order for its current execution state."
                  : "Withdrawal confirmed on chain and in Jupiter's history.",
            },
          )) || operation
        );
      }
      if (history.orders.length < 100) break;
    }
    return (
      (await store.update(wallet, id, ["unknown", "submitting", "submitted"], {
        message:
          "The transaction landed, but the provider record has not been matched. Check Jupiter; do not repeat the deposit.",
      })) || operation
    );
  }
  async function renew(wallet: string, id: string, newId: string) {
    const operation = await store.get(wallet, id);
    if (
      !operationId(newId) ||
      !operation ||
      operation.kind !== "cancel" ||
      operation.state !== "prepared" ||
      !operation.transaction
    )
      throw new Error(
        "Only an expired, unsubmitted withdrawal can be refreshed.",
      );
    const tx = getTransactionDecoder().decode(
        fromBase64(operation.transaction),
      ),
      message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if (
      record(
        await rpc("isBlockhashValid", [
          message.lifetimeToken,
          { commitment: "finalized" },
        ]),
      ).value !== false
    )
      throw new Error(
        "The existing withdrawal is still valid. Use it or wait for it to expire.",
      );
    const closed = await store.update(wallet, id, ["prepared"], {
      state: "abandoned",
      message:
        "Withdrawal transaction expired before submission. Funds remain in the vault until a new withdrawal completes.",
    });
    if (!closed) throw new Error("The request changed. Refresh recovery.");
    return prepare(wallet, {
      id: newId,
      kind: "cancel",
      orderId: operation.orderId,
    });
  }
  return { prepare, submit, reconcile, renew };
}
