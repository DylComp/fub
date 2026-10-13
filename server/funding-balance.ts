import { isMint } from "../src/assets.js";
import { TOKEN_PROGRAM } from "../src/funding-model.js";
import { record } from "../src/live-orders.js";
import { associated } from "../src/transaction-review.js";
import { tokenInfo } from "./funding.js";
import type { Rpc } from "./funding.js";

export async function readFundingBalance(
  wallet: string,
  mint: string,
  rpc: Rpc,
) {
  if (!isMint(wallet) || !isMint(mint))
    throw new Error("Invalid wallet or token contract.");
  const source = await associated(wallet, mint);
  const [token, account] = await Promise.all([
    tokenInfo(mint, rpc),
    rpc("getAccountInfo", [
      source,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]),
  ]);
  const result = record(account);
  if (!("value" in result))
    throw new Error("The funding account could not be verified.");
  const base = {
    wallet,
    mint,
    source,
    decimals: token.decimals,
    fetchedAt: Date.now(),
  };
  if (result.value === null) return { ...base, rawAmount: "0", frozen: false };
  const value = record(result.value),
    parsed = record(record(value.data).parsed);
  const info = record(parsed.info),
    balance = record(info.tokenAmount);
  if (
    value.owner !== TOKEN_PROGRAM ||
    parsed.type !== "account" ||
    info.owner !== wallet ||
    info.mint !== mint ||
    !["initialized", "frozen"].includes(String(info.state)) ||
    balance.decimals !== token.decimals ||
    typeof balance.amount !== "string" ||
    !/^(0|[1-9]\d{0,19})$/.test(balance.amount) ||
    BigInt(balance.amount) > 18446744073709551615n
  )
    throw new Error("The funding account could not be verified.");
  return {
    ...base,
    rawAmount: info.state === "frozen" ? "0" : balance.amount,
    frozen: info.state === "frozen",
  };
}
