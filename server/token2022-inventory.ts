import { isMint } from "../src/assets.js";
import { associated } from "../src/transaction-review.js";
import { record } from "../src/live-orders.js";
import { TOKEN_2022 } from "./jupiter-routes.js";
import {
  inspectToken2022Mint,
  token2022Bytes,
  verifyToken2022Account,
} from "./token2022-setup.js";
import type { Rpc } from "./funding.js";

export async function readToken22Inventory(
  wallet: string,
  mint: string,
  rpc: Rpc,
  minContextSlot: number,
) {
  if (
    !isMint(wallet) ||
    !isMint(mint) ||
    !Number.isSafeInteger(minContextSlot) ||
    minContextSlot < 0
  )
    throw Error("Invalid token inventory request.");
  const source = await associated(wallet, mint, TOKEN_2022);
  const result = record(
    await rpc("getMultipleAccounts", [
      [mint, source],
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
    (slot as number) < Math.max(1, minContextSlot) ||
    !Array.isArray(result.value) ||
    result.value.length !== 2
  )
    throw Error("Current token inventory is unavailable.");
  const config = inspectToken2022Mint(result.value[0], mint);
  const decimals = token2022Bytes(result.value[0])[44];
  if (decimals > 18) throw Error("Unsupported token precision.");
  const base = {
    wallet,
    mint,
    source,
    decimals,
    slot: slot as number,
    fetchedAt: Date.now(),
  };
  if (result.value[1] === null)
    return { ...base, rawAmount: "0", exists: false };
  verifyToken2022Account(result.value[1], wallet, mint, config);
  // Withheld transfer fees are not part of the spendable base amount.
  return {
    ...base,
    rawAmount: token2022Bytes(result.value[1]).readBigUInt64LE(64).toString(),
    exists: true,
  };
}
