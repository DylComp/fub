import type { Rpc } from "./funding.js";
import type { CopyAttempt } from "./copy-ledger.js";
import type { CopyRecoveryEvidence } from "../src/copy-recovery-evidence.js";
import { record } from "../src/live-orders.js";
import { isMint } from "../src/assets.js";
import { MAINNET_GENESIS } from "./solana-network.js";
import { copyReadRpc } from "./copy-rpc.js";
export class RecoveryMismatch extends Error {}
const mismatch = () =>
  new RecoveryMismatch("Finalized recovery evidence is inconsistent.");
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function blockRecoveryRpc(
  endpoint = process.env.SOLANA_ARCHIVE_RPC_URL ||
    process.env.SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com",
  signal?: AbortSignal,
): Rpc {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw Error("Recovery provider is not configured correctly.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    throw Error("Recovery provider is not configured correctly.");
  // Lazy creation: the eight-second transport budget starts only on fallback.
  let read: Rpc | undefined;
  return (method, params) => {
    if (
      !["getGenesisHash", "getSignatureStatuses", "getBlock"].includes(method)
    )
      throw Error("Unsupported block recovery read.");
    read ||= copyReadRpc(parsed.toString(), signal);
    return read(method, params);
  };
}
export async function recoverFromFinalizedBlock(
  attempt: CopyAttempt,
  rpc: Rpc,
): Promise<{ reply: unknown | null; evidence: CopyRecoveryEvidence }> {
  if (!attempt.signature || !attempt.execution || !attempt.prepared)
    throw mismatch();
  return recoverSignedFromFinalizedBlock({signature:attempt.signature,signed:attempt.execution.signed,minContextSlot:attempt.execution.minContextSlot},rpc);
}
// Shared finalized-block lookup. Callers must authenticate the saved execution
// before this read and validate the complete returned receipt before settlement.
export async function recoverSignedFromFinalizedBlock(
  execution:{signature:string;signed:string;minContextSlot:number},rpc:Rpc,
):Promise<{reply:unknown|null;evidence:CopyRecoveryEvidence}>{
  if(!execution.signature||!execution.signed||!Number.isSafeInteger(execution.minContextSlot)||execution.minContextSlot<1)throw mismatch();
  if ((await rpc("getGenesisHash", [])) !== MAINNET_GENESIS) throw mismatch();
  const statuses = record(
    await rpc("getSignatureStatuses", [
      [execution.signature],
      { searchTransactionHistory: true },
    ]),
  );
  const context = record(statuses.context);
  if (
    !Number.isSafeInteger(context.slot) ||
    (context.slot as number) < execution.minContextSlot ||
    !Array.isArray(statuses.value) ||
    statuses.value.length !== 1
  )
    throw mismatch();
  const evidence = (
    kind: CopyRecoveryEvidence["kind"],
    slot?: number,
  ): CopyRecoveryEvidence => ({
    kind,
    checkedAt: Date.now(),
    ...(slot === undefined ? {} : { slot }),
  });
  if (statuses.value[0] === null)
    return { reply: null, evidence: evidence("not_indexed") };
  const status = record(statuses.value[0]),
    slot = status.slot as number;
  if (
    !Number.isSafeInteger(slot) ||
    slot < execution.minContextSlot ||
    slot > (context.slot as number) ||
    !["processed", "confirmed", "finalized"].includes(
      String(status.confirmationStatus),
    ) ||
    !("err" in status)
  )
    throw mismatch();
  if (status.confirmationStatus !== "finalized")
    return { reply: null, evidence: evidence("awaiting_finality", slot) };
  if (status.confirmations !== null) throw mismatch();
  const raw = await rpc("getBlock", [
    slot,
    {
      commitment: "finalized",
      encoding: "base64",
      transactionDetails: "full",
      // A block may contain unrelated v1 transactions. Only the exact saved
      // transaction is selected; its supported format is verified downstream.
      maxSupportedTransactionVersion: 1,
      rewards: false,
    },
  ]);
  if (raw === null)
    return { reply: null, evidence: evidence("receipt_unavailable", slot) };
  const block = record(raw);
  if (
    !isMint(String(block.blockhash)) ||
    !isMint(String(block.previousBlockhash)) ||
    !Number.isSafeInteger(block.parentSlot) ||
    (block.parentSlot as number) < 0 ||
    (block.parentSlot as number) >= slot ||
    !Array.isArray(block.transactions) ||
    block.transactions.length > 16384
  )
    throw mismatch();
  const matches = block.transactions.filter((value) => {
    const tx = record(value).transaction;
    if (
      !Array.isArray(tx) ||
      tx.length !== 2 ||
      typeof tx[0] !== "string" ||
      tx[1] !== "base64"
    )
      throw mismatch();
    return tx[0] === execution.signed;
  });
  if (matches.length !== 1) throw mismatch();
  const match = record(matches[0]),
    meta = record(match.meta);
  if (!("err" in meta) || stable(meta.err) !== stable(status.err))
    throw mismatch();
  // A positive receipt only. The existing full execution validator still checks
  // exact signed bytes, wallet signature, message, lookups, fees and balances.
  return {
    reply: { ...match, slot },
    evidence: evidence("block_receipt", slot),
  };
}
