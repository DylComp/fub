import bs58 from "bs58";
import { isMint } from "../src/assets.js";
import { supportedTokenProgram } from "./jupiter-routes.js";
import pinned from "../docs/pumpswap-route-layouts.json" with { type: "json" };

export const PUMPSWAP = pinned.program;

// Observation only. Finalized owned-account transfers must separately reconcile
// with balances. These layouts do not authorize a follower transaction.
export function decodePumpSwapRoute(ix: Record<string, unknown>) {
  try {
    if (
      ix.programId !== PUMPSWAP ||
      typeof ix.data !== "string" ||
      ix.data.length > 40 ||
      !Array.isArray(ix.accounts) ||
      ix.accounts.length > 32 ||
      ix.accounts.some((a) => typeof a !== "string" || !isMint(a))
    )
      return null;
    const bytes = Buffer.from(bs58.decode(ix.data));
    const layout = pinned.instructions.find((i) =>
      Buffer.from(i.discriminator).equals(bytes.subarray(0, 8)),
    );
    if (!layout || ix.accounts.length < layout.accounts.length) return null;
    const selling = layout.name === "sell";
    if (bytes.length !== (selling ? 24 : 25) || (!selling && bytes[24] > 1))
      return null;
    for (const [index, account] of layout.accounts.entries()) {
      if ("address" in account && account.address !== ix.accounts[index])
        return null;
    }
    const a = ix.accounts as string[];
    if (
      !supportedTokenProgram(a[11]) ||
      !supportedTokenProgram(a[12]) ||
      a[3] === a[4] || a[5] === a[6]
    )
      return null;
    const amount = bytes.readBigUInt64LE(8),
      limit = bytes.readBigUInt64LE(16);
    if (!amount) return null;
    return {
      name: `pumpswap_${layout.name}`,
      authority: a[1],
      source: a[selling ? 5 : 6],
      destination: a[selling ? 6 : 5],
      inputMint: a[selling ? 3 : 4],
      outputMint: a[selling ? 4 : 3],
      inputProgram: a[selling ? 11 : 12],
      outputProgram: a[selling ? 12 : 11],
      token2022: undefined,
      accepts(input: bigint, output: bigint) {
        if (selling) return input === amount && output >= limit;
        if (layout.name === "buy") return output === amount && input <= limit;
        return input <= amount && output >= limit;
      },
    };
  } catch {
    return null;
  }
}
