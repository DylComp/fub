import type { FundingOperation, FundingReceipt } from "../src/funding-model.js";
import { verifyLoadedAddresses } from "../src/lookup-tables.js";
import { record } from "../src/live-orders.js";
import {
  inspectTransfer,
  verifySignedTransfer,
} from "../src/transaction-review.js";
import type { Rpc } from "./funding.js";

// A status lookup proves that a signature landed, not which transfer it represents.
// Match the landed message and wallet signature to the persisted, reviewed transfer.
export async function fundingReceipt(
  operation: FundingOperation,
  rpc: Rpc,
): Promise<FundingReceipt | null> {
  if (!operation.transaction || !operation.review || !operation.signature)
    throw new Error(
      "The original transaction review is missing. Recovery remains open.",
    );
  const reply = await rpc("getTransaction", [
    operation.signature,
    {
      encoding: "base64",
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    },
  ]);
  if (reply === null) return null;
  const transaction = record(reply),
    meta = record(transaction.meta);
  if (
    !Number.isSafeInteger(transaction.slot) ||
    (transaction.slot as number) <= 0 ||
    !(
      transaction.blockTime === null ||
      (Number.isSafeInteger(transaction.blockTime) &&
        (transaction.blockTime as number) > 0)
    ) ||
    meta.err !== null ||
    !Number.isSafeInteger(meta.fee) ||
    (meta.fee as number) < 0 ||
    BigInt(meta.fee as number) > BigInt(operation.review.feeLamports) ||
    !Array.isArray(transaction.transaction) ||
    transaction.transaction.length !== 2 ||
    transaction.transaction[1] !== "base64" ||
    typeof transaction.transaction[0] !== "string"
  )
    throw new Error(
      "Landed transaction details could not be verified. Recovery remains open.",
    );
  const encoded = transaction.transaction[0];
  const signature = await verifySignedTransfer(
    operation.transaction,
    encoded,
    operation.review,
  );
  if (signature !== operation.signature)
    throw new Error("Landed signature did not match the funding request.");
  const transfer = await inspectTransfer(encoded, operation.review);
  verifyLoadedAddresses(
    transfer.message,
    operation.review.lookupTables,
    meta.loadedAddresses,
    transaction.slot as number,
  );
  return {
    signature,
    slot: transaction.slot as number,
    blockTime: transaction.blockTime as number | null,
    feeLamports: String(meta.fee),
    verifiedAt: Date.now(),
    source: transfer.source,
    destination: transfer.destination,
    mint: operation.review.mint,
    amount: operation.review.amount,
    decimals: operation.review.decimals,
  };
}
