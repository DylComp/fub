import { TOKEN_PROGRAM, WSOL } from "../src/funding-model.js";
import { record } from "../src/live-orders.js";
export const SYSTEM = "11111111111111111111111111111111";
export const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export type TokenBalance = {
  owner: string;
  mint: string;
  amount: bigint;
  decimals: number;
  program: string;
};
export function parsedInfo(ix: Record<string, unknown>) {
  if (!ix.parsed || typeof ix.parsed !== "object" || Array.isArray(ix.parsed))
    return { type: undefined, info: {} as Record<string, unknown> };
  const parsed = record(ix.parsed);
  const info =
    parsed.info &&
    typeof parsed.info === "object" &&
    !Array.isArray(parsed.info)
      ? record(parsed.info)
      : {};
  return { type: parsed.type, info };
}
export function parsedAta(ix: Record<string, unknown>) {
  const parsed = parsedInfo(ix),
    info = parsed.info;
  if (
    ix.programId !== ATA ||
    !["create", "createIdempotent"].includes(String(parsed.type)) ||
    info.systemProgram !== SYSTEM
  )
    return null;
  return {
    account: String(info.account),
    owner: String(info.wallet),
    mint: String(info.mint),
    program: String(info.tokenProgram),
  };
}
// Native amounts are taken from route token transfers. Rent, tips and wrapping are never trade volume.
export function nativeLifecycle(args: {
  account: string;
  leader: string;
  routeIndex: number;
  instructions: Record<string, unknown>[];
  pre?: TokenBalance;
  post?: TokenBalance;
  keys: Record<string, unknown>[];
  meta: Record<string, unknown>;
}) {
  const { account, leader, routeIndex, instructions, pre, post, keys, meta } =
    args;
  const setup = instructions
    .map((ix, index) => ({ ata: parsedAta(ix), index }))
    .filter((x) => x.ata?.account === account);
  if (setup.length > 1) return null;
  const creation = setup[0];
  if (
    !pre &&
    (!creation ||
      creation.index >= routeIndex ||
      creation.ata!.owner !== leader ||
      creation.ata!.mint !== WSOL ||
      creation.ata!.program !== TOKEN_PROGRAM)
  )
    return null;
  if (
    (pre &&
      (pre.owner !== leader ||
        pre.mint !== WSOL ||
        pre.program !== TOKEN_PROGRAM ||
        pre.decimals !== 9)) ||
    (post &&
      (post.owner !== leader ||
        post.mint !== WSOL ||
        post.program !== TOKEN_PROGRAM ||
        post.decimals !== 9))
  )
    return null;
  let deposits = 0n,
    lastDeposit = -1,
    lastSync = -1,
    close = -1;
  const allowed = new Set<number>();
  for (const [index, ix] of instructions.entries()) {
    const parsed = parsedInfo(ix),
      info = parsed.info;
    if (
      ix.programId === SYSTEM &&
      parsed.type === "transfer" &&
      info.destination === account
    ) {
      if (
        info.source !== leader ||
        index >= routeIndex ||
        !Number.isSafeInteger(info.lamports) ||
        (info.lamports as number) <= 0
      )
        return null;
      deposits += BigInt(info.lamports as number);
      if (deposits > 18446744073709551615n) return null;
      lastDeposit = index;
      allowed.add(index);
    }
    if (ix.programId === TOKEN_PROGRAM && info.account === account) {
      if (parsed.type === "syncNative" && index < routeIndex) {
        lastSync = index;
        allowed.add(index);
      } else if (
        parsed.type === "closeAccount" &&
        index > routeIndex &&
        info.owner === leader &&
        info.destination === leader &&
        close < 0
      ) {
        close = index;
        allowed.add(index);
      } else return null;
    }
  }
  if (lastDeposit >= 0 && lastSync <= lastDeposit) return null;
  if (!post && close < 0) return null;
  const keyIndex = keys.findIndex((k) => k.pubkey === account);
  const before = Array.isArray(meta.preBalances)
      ? meta.preBalances[keyIndex]
      : undefined,
    after = Array.isArray(meta.postBalances)
      ? meta.postBalances[keyIndex]
      : undefined;
  if (
    !Number.isSafeInteger(before) ||
    !Number.isSafeInteger(after) ||
    before < 0 ||
    after < 0 ||
    (!pre && before !== 0) ||
    (close >= 0 && (after !== 0 || post))
  )
    return null;
  if (pre && BigInt(before) < pre.amount) return null;
  if (post && BigInt(after) < post.amount) return null;
  return {
    allowed,
    deposits,
    closed: close >= 0,
    before: pre?.amount || 0n,
    postAmount: post?.amount,
    native: deposits > 0n || close >= 0,
  };
}
