import { createHash } from "node:crypto";
import bs58 from "bs58";
import { isMint } from "../src/assets.js";
import { TOKEN_PROGRAM } from "../src/funding-model.js";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const JUPITER_V6 = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const supportedTokenProgram = (program: string) =>
  [TOKEN_PROGRAM, TOKEN_2022].includes(program);
type Layout = {
  authority: number;
  source: number;
  destination: number;
  inputMint?: number;
  outputMint: number;
  inputProgram?: number;
  outputProgram?: number;
  token2022?: number;
};
// Pinned from the program-owned on-chain Anchor IDL. See docs/jupiter-route-layouts.json.
const layouts: Record<string, Layout> = {
  route: {
    authority: 1,
    source: 2,
    destination: 3,
    outputMint: 5,
    inputProgram: 0,
  },
  exact_out_route: {
    authority: 1,
    source: 2,
    destination: 3,
    inputMint: 5,
    outputMint: 6,
    inputProgram: 0,
    token2022: 8,
  },
  shared_accounts_route: {
    authority: 2,
    source: 3,
    destination: 6,
    inputMint: 7,
    outputMint: 8,
    inputProgram: 0,
    token2022: 10,
  },
  shared_accounts_exact_out_route: {
    authority: 2,
    source: 3,
    destination: 6,
    inputMint: 7,
    outputMint: 8,
    inputProgram: 0,
    token2022: 10,
  },
  route_v2: {
    authority: 0,
    source: 1,
    destination: 2,
    inputMint: 3,
    outputMint: 4,
    inputProgram: 5,
    outputProgram: 6,
  },
  exact_out_route_v2: {
    authority: 0,
    source: 1,
    destination: 2,
    inputMint: 3,
    outputMint: 4,
    inputProgram: 5,
    outputProgram: 6,
  },
  shared_accounts_route_v2: {
    authority: 1,
    source: 2,
    destination: 5,
    inputMint: 6,
    outputMint: 7,
    inputProgram: 8,
    outputProgram: 9,
  },
  shared_accounts_exact_out_route_v2: {
    authority: 1,
    source: 2,
    destination: 5,
    inputMint: 6,
    outputMint: 7,
    inputProgram: 8,
    outputProgram: 9,
  },
};
const byDiscriminator = new Map(
  Object.entries(layouts).map(([name, layout]) => [
    createHash("sha256").update(`global:${name}`).digest("hex").slice(0, 16),
    { name, layout },
  ]),
);
export function decodeJupiterRoute(ix: Record<string, unknown>) {
  if (
    ix.programId !== JUPITER_V6 ||
    !Array.isArray(ix.accounts) ||
    ix.accounts.some((a) => typeof a !== "string") ||
    typeof ix.data !== "string"
  )
    return null;
  let data: Uint8Array;
  try {
    data = bs58.decode(ix.data);
  } catch {
    return null;
  }
  if (data.length < 31) return null;
  const format = byDiscriminator.get(
    Buffer.from(data.slice(0, 8)).toString("hex"),
  );
  if (!format) return null;
  const { name, layout: l } = format,
    a = ix.accounts as string[];
  const required = [
    l.authority,
    l.source,
    l.destination,
    l.outputMint,
    l.inputMint,
    l.inputProgram,
    l.outputProgram,
  ].filter((i): i is number => i !== undefined);
  if (required.some((i) => !isMint(a[i] || ""))) return null;
  return {
    name,
    authority: a[l.authority],
    source: a[l.source],
    destination: a[l.destination],
    inputMint: l.inputMint === undefined ? undefined : a[l.inputMint],
    outputMint: a[l.outputMint],
    inputProgram: l.inputProgram === undefined ? undefined : a[l.inputProgram],
    outputProgram:
      l.outputProgram === undefined ? undefined : a[l.outputProgram],
    token2022: l.token2022 === undefined ? undefined : a[l.token2022],
  };
}
