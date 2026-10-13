import { record } from "../src/live-orders.js";
import { isMint } from "../src/assets.js";
import type { TokenFeeReport, TransferFee } from "../src/token-fees.js";
import { tokenUnits } from "../src/token-fees.js";
import {
  inspectToken2022Mint,
  token2022Bytes,
  tokenExtensions,
} from "./token2022-setup.js";
import type { Rpc } from "./funding.js";
export const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const SYSVAR = "Sysvar1111111111111111111111111111111111111";
const invalid = (): never => {
  throw Error("Token transfer fees could not be verified.");
};
export function inspectTokenFees(value: unknown, mint: string, epoch: string) {
  const currentEpoch = tokenUnits(epoch),
    setup = inspectToken2022Mint(value, mint),
    bytes = token2022Bytes(value);
  const data = tokenExtensions(bytes, 1).get(1);
  if (!data)
    return {
      decimals: bytes[44],
      mintHash: setup.mintHash,
      canChange: false,
      current: { epoch: "0", basisPoints: 0, maximumRaw: "0" },
    };
  const at = (offset: number): TransferFee => ({
    epoch: data.readBigUInt64LE(offset).toString(),
    maximumRaw: data.readBigUInt64LE(offset + 8).toString(),
    basisPoints: data.readUInt16LE(offset + 16),
  });
  const older = at(72),
    newer = at(90);
  const current = currentEpoch >= BigInt(newer.epoch) ? newer : older;
  // A pre-configuration epoch is not historical fee evidence.
  if (currentEpoch < BigInt(current.epoch)) return invalid();
  return {
    decimals: bytes[44],
    mintHash: setup.mintHash,
    canChange: data.subarray(0, 32).some((v) => v !== 0),
    current,
    ...(currentEpoch < BigInt(newer.epoch) ? { scheduled: newer } : {}),
  };
}
export function clockEpoch(value: unknown, expectedSlot: number) {
  const a = record(value);
  if (
    a.owner !== SYSVAR ||
    a.executable !== false ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== "base64" ||
    typeof a.data[0] !== "string" ||
    a.data[0].length !== 56
  )
    return invalid();
  const b = Buffer.from(a.data[0], "base64");
  if (
    b.length !== 40 ||
    b.toString("base64") !== a.data[0] ||
    b.readBigUInt64LE(0) !== BigInt(expectedSlot)
  )
    return invalid();
  return b.readBigUInt64LE(16).toString();
}
export async function readTokenFees(
  mint: string,
  rpc: Rpc,
): Promise<TokenFeeReport> {
  if (!isMint(mint)) return invalid();
  const reply = record(
    await rpc("getMultipleAccounts", [
      [mint, CLOCK],
      { encoding: "base64", commitment: "finalized" },
    ]),
  );
  const slot = record(reply.context).slot;
  if (
    !Number.isSafeInteger(slot) ||
    (slot as number) < 1 ||
    !Array.isArray(reply.value) ||
    reply.value.length !== 2
  )
    return invalid();
  const epoch = clockEpoch(reply.value[1], slot as number);
  return {
    mint,
    slot: slot as number,
    epoch,
    fetchedAt: Date.now(),
    ...inspectTokenFees(reply.value[0], mint, epoch),
  };
}
