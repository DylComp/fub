import {Keypair,VersionedTransaction} from "@solana/web3.js";
// Only a dedicated platform fee wallet, setup sponsor or treasury belongs here.
// User wallet keys, Privy secrets and the developer wallet never enter this runtime.
export function feeCronSigner(serialized: string | undefined, expected: string) {
  let value: unknown;
  try {
    if (!serialized || serialized.length > 1024) throw Error();
    value = JSON.parse(serialized);
    if (!Array.isArray(value) || value.length !== 64 || value.some(v => !Number.isInteger(v) || v < 0 || v > 255)) throw Error();
  } catch { throw Error("Invalid scheduled fee signer configuration."); }
  const key = Keypair.fromSecretKey(Uint8Array.from(value as number[]));
  if (key.publicKey.toBase58() !== expected) throw Error("Scheduled fee signer address mismatch.");
  return async (unsigned: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const tx = VersionedTransaction.deserialize(Buffer.from(unsigned, "base64"));
    if (tx.message.header.numRequiredSignatures !== 1 || tx.message.staticAccountKeys[0].toBase58() !== expected)
      throw Error("Unexpected scheduled fee transaction signer.");
    tx.sign([key]);
    signal.throwIfAborted();
    return Buffer.from(tx.serialize()).toString("base64");
  };
}

