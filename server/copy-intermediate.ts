import bs58 from "bs58";
import { TOKEN_PROGRAM, WSOL } from "../src/funding-model.js";
import { associated } from "../src/transaction-review.js";
import { record } from "../src/live-orders.js";
import type { Rpc } from "./funding.js";

export type CopyIntermediate = {
  address: string;
  mint: string;
  createsAccount: boolean;
};
const invalid = (): never => {
  throw new Error(
    "Wrapped SOL intermediary is not empty, unchanged or verified.",
  );
};

// Standard SPL Account layout. Native reserve and lamports must agree exactly:
// reject funded WSOL and unsynchronized SOL deposits as well as delegates.
export function verifyEmptyWrappedAccount(
  value: unknown,
  wallet: string,
  lamports?: number,
) {
  const a = record(value),
    data = a.data;
  if (
    a.owner !== TOKEN_PROGRAM ||
    a.executable !== false ||
    !Number.isSafeInteger(a.lamports) ||
    (a.lamports as number) < 1 ||
    (a.lamports as number) > 2_500_000 ||
    (lamports !== undefined && a.lamports !== lamports) ||
    !Array.isArray(data) ||
    data.length !== 2 ||
    data[1] !== "base64" ||
    typeof data[0] !== "string" ||
    data[0].length !== 220
  )
    return invalid();
  const b = Buffer.from(data[0], "base64");
  if (
    b.length !== 165 ||
    b.toString("base64") !== data[0] ||
    bs58.encode(b.subarray(0, 32)) !== WSOL ||
    bs58.encode(b.subarray(32, 64)) !== wallet ||
    b.readBigUInt64LE(64) !== 0n ||
    b.readUInt32LE(72) !== 0 ||
    b[108] !== 1 ||
    b.readUInt32LE(109) !== 1 ||
    b.readBigUInt64LE(113) !== BigInt(a.lamports as number) ||
    b.readBigUInt64LE(121) !== 0n ||
    (b.readUInt32LE(129) !== 0 &&
      (b.readUInt32LE(129) !== 1 ||
        bs58.encode(b.subarray(133, 165)) !== wallet))
  )
    return invalid();
}

export async function readCopyIntermediate(
  wallet: string,
  intermediate: CopyIntermediate,
  rpc: Rpc,
  minContextSlot: number,
) {
  if (
    !Number.isSafeInteger(minContextSlot) ||
    minContextSlot < 1 ||
    intermediate.mint !== WSOL ||
    intermediate.address !== (await associated(wallet, WSOL)) ||
    typeof intermediate.createsAccount !== "boolean"
  )
    return invalid();
  const result = record(
    await rpc("getAccountInfo", [
      intermediate.address,
      {
        encoding: "base64",
        commitment: "finalized",
        minContextSlot,
      },
    ]),
  );
  const slot = record(result.context).slot;
  if (!Number.isSafeInteger(slot) || (slot as number) < minContextSlot)
    return invalid();
  if (result.value === null) {
    if (!intermediate.createsAccount) return invalid();
  } else verifyEmptyWrappedAccount(result.value, wallet);
  return {
    address: intermediate.address,
    wallet,
    exists: result.value !== null,
    slot: slot as number,
    fetchedAt: Date.now(),
  };
}

// Same-bank before/after evidence, shared by unsigned simulation and finalized
// receipt recovery. The intermediate is retained, never closed or credited as P&L.
export function intermediateRent(
  intermediate: CopyIntermediate | undefined,
  wallet: string,
  keys: readonly string[],
  meta: Record<string, unknown>,
) {
  if (!intermediate) return 0n;
  const n = keys.indexOf(intermediate.address);
  const pre = meta.preBalances,
    post = meta.postBalances;
  if (
    intermediate.mint !== WSOL ||
    n < 1 ||
    !Array.isArray(pre) ||
    !Array.isArray(post) ||
    !Number.isSafeInteger(pre[n]) ||
    pre[n] < 0 ||
    !Number.isSafeInteger(post[n]) ||
    post[n] < 1
  )
    return invalid();
  function token(rows: unknown, required: boolean) {
    if (!Array.isArray(rows)) return invalid();
    const matching = rows.filter((v) => record(v).accountIndex === n);
    if (!matching.length && !required) return false;
    if (matching.length !== 1) return invalid();
    const t = record(matching[0]),
      amount = record(t.uiTokenAmount);
    if (
      t.owner !== wallet ||
      t.mint !== WSOL ||
      t.programId !== TOKEN_PROGRAM ||
      amount.decimals !== 9 ||
      amount.amount !== "0"
    )
      return invalid();
    return true;
  }
  const existed = token(meta.preTokenBalances, false);
  token(meta.postTokenBalances, true);
  if (
    existed ? pre[n] !== post[n] : pre[n] !== 0 || !intermediate.createsAccount
  )
    return invalid();
  const rent = BigInt(post[n]) - BigInt(pre[n]);
  if (rent < 0n || rent > 2500000n) return invalid();
  return rent;
}
