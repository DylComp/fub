import { createHash } from "node:crypto";
import bs58 from "bs58";
import { WHIRLPOOL_PROGRAM } from "../src/copy-swap.js";
import type { CopyWhirlpool, SwapInstruction } from "../src/copy-swap.js";
import { TOKEN_PROGRAM } from "../src/funding-model.js";
import { isMint } from "../src/assets.js";
import { record } from "../src/live-orders.js";
import type { Rpc } from "./funding.js";

// https://github.com/orca-so/whirlpools/blob/main/programs/whirlpool/src/state/whirlpool.rs
// Pinned classic Whirlpool layout from Orca's program source. A changed layout
// is unsupported until reviewed. Price/tick/liquidity values are not quotes.
const DISCRIMINATOR = createHash("sha256")
  .update("account:Whirlpool")
  .digest()
  .subarray(0, 8);
function accountBytes(value: unknown, owner: string, size: number) {
  const account = record(value),
    data = account.data;
  if (
    account.owner !== owner ||
    account.executable !== false ||
    !Array.isArray(data) ||
    data.length !== 2 ||
    data[1] !== "base64" ||
    typeof data[0] !== "string" ||
    data[0].length !== Math.ceil(size / 3) * 4
  )
    throw new Error("Unsupported Whirlpool account evidence.");
  const bytes = Buffer.from(data[0], "base64");
  if (bytes.length !== size || bytes.toString("base64") !== data[0])
    throw new Error("Invalid Whirlpool account encoding.");
  return bytes;
}
export function whirlpoolReadAddresses(routes: CopyWhirlpool[]) {
  return [
    ...new Set(routes.flatMap((r) => [r.pool, r.inputMint, r.outputMint])),
  ];
}
export async function verifyCopyWhirlpools(
  routes: CopyWhirlpool[],
  instructions: SwapInstruction[],
  rpc: Rpc,
  minContextSlot: number,
) {
  if (
    !Number.isSafeInteger(minContextSlot) ||
    minContextSlot < 1 ||
    !Array.isArray(routes) ||
    routes.length > 8
  )
    throw new Error("Invalid Whirlpool verification request.");
  if (!routes.length) return minContextSlot;
  if (
    routes.some(
      (r) =>
        ![r.pool, r.inputMint, r.outputMint].every(isMint) ||
        r.inputMint === r.outputMint ||
        typeof r.aToB !== "boolean",
    )
  )
    throw new Error("Invalid Whirlpool route identity.");
  const addresses = whirlpoolReadAddresses(routes);
  const result = record(
    await rpc("getMultipleAccounts", [
      addresses,
      { encoding: "base64", commitment: "finalized", minContextSlot },
    ]),
  );
  const slot = record(result.context).slot;
  if (
    !Number.isSafeInteger(slot) ||
    (slot as number) < minContextSlot ||
    !Array.isArray(result.value) ||
    result.value.length !== addresses.length
  )
    throw new Error("Whirlpool pool evidence is stale or missing.");
  const accounts = new Map(
    addresses.map((key, i) => [key, (result.value as unknown[])[i]]),
  );
  const remaining = instructions.at(-1)?.accounts.slice(12) || [];
  for (const route of routes) {
    const pool = accountBytes(accounts.get(route.pool), WHIRLPOOL_PROGRAM, 653);
    if (!pool.subarray(0, 8).equals(DISCRIMINATOR))
      throw new Error("Whirlpool account discriminator changed.");
    const mintA = bs58.encode(pool.subarray(101, 133));
    const mintB = bs58.encode(pool.subarray(181, 213));
    if (
      route.inputMint !== (route.aToB ? mintA : mintB) ||
      route.outputMint !== (route.aToB ? mintB : mintA)
    )
      throw new Error(
        "Whirlpool token direction does not match the quoted pool.",
      );
    for (const offset of [133, 213]) {
      const vault = bs58.encode(pool.subarray(offset, offset + 32));
      if (
        !remaining.some(
          (a) => a.pubkey === vault && a.isWritable && !a.isSigner,
        )
      )
        throw new Error("Whirlpool token vault is missing from the route.");
    }
    for (const mint of [mintA, mintB]) {
      const bytes = accountBytes(accounts.get(mint), TOKEN_PROGRAM, 82);
      if (bytes[45] !== 1 || bytes[44] > 18)
        throw new Error("Unsupported Whirlpool token precision or mint state.");
    }
  }
  return slot as number;
}
