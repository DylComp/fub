import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { VersionedTransactionResponse } from "@solana/web3.js";
import bs58 from "bs58";
import type { Rpc } from "./funding.js";
import { recoverSignedFromFinalizedBlock } from "./copy-block-recovery.js";
import { record } from "../src/live-orders.js";

// Positive finalized evidence only. Callers first validate their saved plan and
// signature, then run their full balance/fee/recipient checks on this receipt.
export async function recoverWorkerReceipt(
  execution: { signature: string; signed: string; minContextSlot: number },
  rpc: Rpc,
): Promise<VersionedTransactionResponse | null> {
  const recovered = await recoverSignedFromFinalizedBlock(execution, rpc);
  if (!recovered.reply) return null;
  const reply = record(recovered.reply);
  const saved = VersionedTransaction.deserialize(Buffer.from(execution.signed, "base64"));
  if (bs58.encode(saved.signatures[0]) !== execution.signature)
    throw Error("Worker recovery signature mismatch.");
  const meta = record(reply.meta);
  let loadedAddresses: { writable: PublicKey[]; readonly: PublicKey[] } | undefined;
  if (meta.loadedAddresses !== undefined) {
    const loaded = record(meta.loadedAddresses);
    const decode = (value: unknown) => {
      if (!Array.isArray(value) || value.length > 256) throw Error("Invalid recovered lookup addresses.");
      return value.map(address => {
        if (typeof address !== "string") throw Error("Invalid recovered lookup address.");
        const key = new PublicKey(address);
        if (key.toBase58() !== address) throw Error("Noncanonical recovered lookup address.");
        return key;
      });
    };
    loadedAddresses = { writable: decode(loaded.writable), readonly: decode(loaded.readonly) };
  }
  return {
    slot: reply.slot as number,
    version: saved.version,
    transaction: {
      message: saved.message,
      signatures: saved.signatures.map(signature => bs58.encode(signature)),
    },
    meta: { ...meta, ...(loadedAddresses ? { loadedAddresses } : {}) } as VersionedTransactionResponse["meta"],
  };
}
