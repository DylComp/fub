import { PUMP_AMM_PROGRAM } from "../src/copy-pumpswap.js";
import { verifyPumpSegments } from "./copy-pumpswap.js";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import {
  directCopySegments,
  RAYDIUM_CLMM_PROGRAM,
  decodeCopyRoute,
  instructionBytes,
} from "../src/copy-swap.js";
import type { SwapInstruction } from "../src/copy-swap.js";
import { TOKEN_PROGRAM, WSOL } from "../src/funding-model.js";
import { record } from "../src/live-orders.js";
import { associated } from "../src/transaction-review.js";
import type { Rpc } from "./funding.js";
import { TOKEN_2022 } from "./jupiter-routes.js";
import {
  inspectToken2022Mint,
  token2022Bytes,
  verifyToken2022Account,
} from "./token2022-setup.js";

const invalid = (): never => {
  throw new Error(
    "Direct pool evidence is stale, unsupported or inconsistent.",
  );
};
const discriminator = (name: string) =>
  createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);

// PoolState, SwapSingle, TickArrayState, TickArrayBitmapExtension and
// ObservationState layouts pinned to raydium-io/raydium-clmm commit
// ed7c84a54ced59c55981780546adb0b4583dcf85 (see docs/direct-copy-routes.md).
export async function verifyCopyDirectPools(
  instructions: SwapInstruction[],
  rpc: Rpc,
  minContextSlot: number,
) {
  if (!Number.isSafeInteger(minContextSlot) || minContextSlot < 1)
    return invalid();
  const swap = instructions.at(-1);
  if (!swap) return invalid();
  const route = decodeCopyRoute(instructionBytes(swap.data));
  const intermediate =
    route.kind === "direct" && route.intermediateNode !== undefined
      ? await associated(swap.accounts[0].pubkey, WSOL)
      : undefined;
  const allSegments = directCopySegments(swap, intermediate);
  const pumpSegments = allSegments.filter(
    (s) => s[0].pubkey === PUMP_AMM_PROGRAM,
  );
  const pumpSlot = await verifyPumpSegments(
    pumpSegments,
    swap.accounts[0].pubkey,
    rpc,
    minContextSlot,
  );
  const segments = allSegments.filter(
    (s) => s[0].pubkey === RAYDIUM_CLMM_PROGRAM,
  );
  if (!segments.length) return pumpSlot;
  return Math.max(
    pumpSlot,
    await verifyRaydiumPoolAccounts(
      swap,
      segments,
      rpc,
      minContextSlot,
      intermediate,
    ),
  );
}

// Caller must validate the instruction header, segment order and account roles.
// Token-2022 V2 inspection is separate from the copy execution allowlist.
export async function verifyRaydiumPoolAccounts(
  swap: SwapInstruction,
  segments: SwapInstruction["accounts"][],
  rpc: Rpc,
  minContextSlot: number,
  intermediate?: string,
  v2 = false,
  allowTransferFees = false,
) {
  if (
    !Number.isSafeInteger(minContextSlot) ||
    minContextSlot < 1 ||
    !segments.length
  )
    return invalid();
  const addresses = [
    ...new Set([
      swap.accounts[3].pubkey,
      swap.accounts[4].pubkey,
      ...(intermediate ? [WSOL] : []),
      ...segments.flatMap((section) =>
        section
          .filter(
            (_, i) =>
              !(v2 ? [0, 1, 4, 5, 9, 10, 11] : [0, 1, 4, 5, 9]).includes(i),
          )
          .map((a) => a.pubkey),
      ),
    ]),
  ];
  if (addresses.length > 100) return invalid();
  const result = record(
    await rpc("getMultipleAccounts", [
      addresses,
      {
        encoding: "base64",
        commitment: "finalized",
        minContextSlot,
      },
    ]),
  );
  const slot = record(result.context).slot;
  if (
    !Number.isSafeInteger(slot) ||
    (slot as number) < minContextSlot ||
    !Array.isArray(result.value) ||
    result.value.length !== addresses.length ||
    result.value.some((v) => !v || typeof v !== "object" || Array.isArray(v))
  )
    return invalid();
  const values = new Map(
    addresses.map((a, i) => [a, (result.value as unknown[])[i]]),
  );
  function bytes(key: string, owner: string, length: number) {
    const a = record(values.get(key)),
      data = a.data;
    if (
      a.owner !== owner ||
      a.executable !== false ||
      !Array.isArray(data) ||
      data.length !== 2 ||
      data[1] !== "base64" ||
      typeof data[0] !== "string" ||
      data[0].length !== Math.ceil(length / 3) * 4
    )
      return invalid();
    const b = Buffer.from(data[0], "base64");
    if (b.length !== length || b.toString("base64") !== data[0])
      return invalid();
    return b;
  }
  function state(key: string, name: string, length: number) {
    const b = bytes(key, RAYDIUM_CLMM_PROGRAM, length);
    if (!b.subarray(0, 8).equals(discriminator(name))) return invalid();
    return b;
  }
  const keyAt = (b: Buffer, offset: number) =>
    bs58.encode(b.subarray(offset, offset + 32));
  for (const a of segments) {
    const poolKey = a[3].pubkey,
      pool = state(poolKey, "PoolState", 1544);
    const mint0 = keyAt(pool, 73),
      mint1 = keyAt(pool, 105);
    const mintFor = (key: string) =>
      key === swap.accounts[1].pubkey
        ? swap.accounts[3].pubkey
        : key === swap.accounts[2].pubkey
          ? swap.accounts[4].pubkey
          : key === intermediate
            ? WSOL
            : "";
    if (
      v2 &&
      (record(values.get(swap.accounts[3].pubkey)).owner !==
        swap.accounts[5].pubkey ||
        record(values.get(swap.accounts[4].pubkey)).owner !==
          swap.accounts[6].pubkey)
    )
      return invalid();
    const input = mintFor(a[4].pubkey),
      output = mintFor(a[5].pubkey);
    const zeroForOne = input === mint0 && output === mint1;
    if (
      (!zeroForOne && !(input === mint1 && output === mint0)) ||
      keyAt(pool, 9) !== a[2].pubkey ||
      keyAt(pool, 201) !== a[8].pubkey ||
      keyAt(pool, zeroForOne ? 137 : 169) !== a[6].pubkey ||
      keyAt(pool, zeroForOne ? 169 : 137) !== a[7].pubkey ||
      (pool[389] & 16) !== 0
    )
      return invalid();
    state(a[2].pubkey, "AmmConfig", 117);
    const observation = state(a[8].pubkey, "ObservationState", 4483);
    if (keyAt(observation, 19) !== poolKey) return invalid();
    for (const [mint, decimals] of [
      [mint0, pool[233]],
      [mint1, pool[234]],
    ] as const) {
      const value = values.get(mint);
      const extended = v2 && record(value).owner === TOKEN_2022;
      if (
        extended &&
        inspectToken2022Mint(value, mint).transferFee &&
        !allowTransferFees
      )
        return invalid();
      const m = extended
        ? token2022Bytes(value)
        : bytes(mint, TOKEN_PROGRAM, 82);
      if (m[45] !== 1 || m[44] > 18 || m[44] !== decimals) return invalid();
    }
    for (const [index, mint] of [
      [6, input],
      [7, output],
    ] as const) {
      const mintValue = values.get(mint);
      const extended = v2 && record(mintValue).owner === TOKEN_2022;
      if (extended)
        verifyToken2022Account(
          values.get(a[index].pubkey),
          poolKey,
          mint,
          inspectToken2022Mint(mintValue, mint),
        );
      const vault = extended
        ? token2022Bytes(values.get(a[index].pubkey))
        : bytes(a[index].pubkey, TOKEN_PROGRAM, 165);
      if (
        keyAt(vault, 0) !== mint ||
        keyAt(vault, 32) !== poolKey ||
        vault[108] !== 1 ||
        vault.readUInt32LE(72) !== 0 ||
        vault.readUInt32LE(129) !== 0
      )
        return invalid();
    }
    let ticks = 0,
      bitmaps = 0;
    if (v2 && (a[12].pubkey !== input || a[13].pubkey !== output))
      return invalid();
    for (const extra of a.slice(v2 ? 14 : 10)) {
      const data = record(values.get(extra.pubkey)).data;
      if (!Array.isArray(data) || typeof data[0] !== "string") return invalid();
      const isBitmap = data[0].length === Math.ceil(1832 / 3) * 4;
      const b = state(
        extra.pubkey,
        isBitmap ? "TickArrayBitmapExtension" : "TickArrayState",
        isBitmap ? 1832 : 10240,
      );
      if (keyAt(b, 8) !== poolKey) return invalid();
      if (isBitmap) bitmaps++;
      else ticks++;
    }
    if (!ticks || bitmaps > 1) return invalid();
  }
  return slot as number;
}
