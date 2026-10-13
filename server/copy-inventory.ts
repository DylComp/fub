import { isMint } from "../src/assets.js";
import { TOKEN_PROGRAM } from "../src/funding-model.js";
import { record } from "../src/live-orders.js";
import { associated } from "../src/transaction-review.js";
import type { Rpc } from "./funding.js";
export class UnsupportedCopyToken extends Error {constructor(){super('Unsupported copy token.');}}

// Only the wallet's standard SPL associated account is eligible for copy execution.
// A finalized snapshot must cover every already-settled trade in the ledger.
export async function readCopyInventory(
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
    throw new Error("Invalid copy inventory request.");
  const source = await associated(wallet, mint);
  const result = record(
    await rpc("getMultipleAccounts", [
      [mint, source],
      {
        encoding: "jsonParsed",
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
    throw new Error("Current copy inventory is unavailable.");
  const token = record(result.value[0]);
  if(token.owner!==TOKEN_PROGRAM)throw new UnsupportedCopyToken();
  const parsed = record(record(token.data).parsed),
    info = record(parsed.info);
  if (
    token.owner !== TOKEN_PROGRAM ||
    token.executable !== false ||
    parsed.type !== "mint" ||
    info.isInitialized !== true ||
    !Number.isInteger(info.decimals) ||
    (info.decimals as number) < 0 ||
    (info.decimals as number) > 18
  )
    throw new UnsupportedCopyToken();
  const base = {
    wallet,
    mint,
    source,
    decimals: info.decimals as number,
    slot: slot as number,
    fetchedAt: Date.now(),
  };
  if (result.value[1] === null)
    return { ...base, rawAmount: "0", exists: false };
  const account = record(result.value[1]),
    accountData = record(record(account.data).parsed),
    owner = record(accountData.info),
    balance = record(owner.tokenAmount);
  if (
    account.owner !== TOKEN_PROGRAM ||
    account.executable !== false ||
    accountData.type !== "account" ||
    owner.owner !== wallet ||
    owner.mint !== mint ||
    owner.state !== "initialized" ||
    owner.isNative !== false ||
    owner.delegate !== undefined ||
    (owner.closeAuthority !== undefined && owner.closeAuthority !== wallet) ||
    balance.decimals !== info.decimals ||
    typeof balance.amount !== "string" ||
    !/^(0|[1-9]\d{0,19})$/.test(balance.amount) ||
    BigInt(balance.amount) > 18446744073709551615n
  )
    throw new Error(
      "The copy token account is frozen, delegated or could not be verified.",
    );
  return { ...base, rawAmount: balance.amount, exists: true };
}
