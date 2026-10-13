import { createHash } from "node:crypto";
import bs58 from "bs58";
import { record } from "../src/live-orders.js";
import type { TokenSetupConfig } from "../src/account-readiness.js";
import { TOKEN_2022 } from "./jupiter-routes.js";

export class TokenSetupUnsupported extends Error {}
const invalid = (): never => {
  throw new TokenSetupUnsupported(
    "Token extension data could not be verified.",
  );
};
export function token2022Bytes(value: unknown, max = 16384) {
  const a = record(value);
  if (
    a.owner !== TOKEN_2022 ||
    a.executable !== false ||
    !Number.isSafeInteger(a.lamports) ||
    (a.lamports as number) < 1 ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== "base64" ||
    typeof a.data[0] !== "string" ||
    a.data[0].length > Math.ceil(max / 3) * 4
  )
    return invalid();
  const b = Buffer.from(a.data[0], "base64");
  if (b.length > max || b.toString("base64") !== a.data[0]) return invalid();
  return b;
}
export function tokenExtensions(b: Buffer, kind: 1 | 2) {
  const base = kind === 1 ? 82 : 165;
  if (b.length === base) return new Map<number, Buffer>();
  if (
    b.length < 166 ||
    b.length === 355 ||
    b[165] !== kind ||
    (kind === 1 && b.subarray(82, 165).some((v) => v !== 0))
  )
    return invalid();
  const result = new Map<number, Buffer>();
  for (let n = 166; n < b.length; ) {
    if (b.subarray(n).every((v) => v === 0)) break;
    if (n + 4 > b.length) return invalid();
    const type = b.readUInt16LE(n),
      length = b.readUInt16LE(n + 2);
    n += 4;
    if (!type || result.has(type) || n + length > b.length || result.size >= 16)
      return invalid();
    result.set(type, b.subarray(n, n + length));
    n += length;
  }
  return result;
}
function metadata(b: Buffer, mint: string) {
  if (b.length < 80 || bs58.encode(b.subarray(32, 64)) !== mint)
    return invalid();
  let at = 64;
  const string = () => {
    if (at + 4 > b.length) return invalid();
    const length = b.readUInt32LE(at);
    at += 4;
    if (length > 8192 || at + length > b.length) return invalid();
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(
        b.subarray(at, at + length),
      );
    } catch {
      return invalid();
    }
    at += length;
  };
  string();
  string();
  string();
  if (at + 4 > b.length) return invalid();
  const count = b.readUInt32LE(at);
  at += 4;
  if (count > 64) return invalid();
  for (let n = 0; n < count; n++) {
    string();
    string();
  }
  if (at !== b.length) return invalid();
}
const unsupported: Record<number, string> = {
  3: "mint-close authority",
  4: "confidential transfers",
  6: "default account state",
  9: "non-transferable tokens",
  10: "interest-bearing amounts",
  12: "permanent delegate",
  14: "transfer hooks",
  16: "confidential transfer fees",
  25: "scaled amounts",
  26: "pausable tokens",
  28: "permissioned burns",
};
// Setup only. This allowlist does not authorize swapping these tokens.
export function inspectToken2022Mint(
  value: unknown,
  mint: string,
): TokenSetupConfig {
  const b = token2022Bytes(value);
  if (
    b.length < 82 ||
    b[45] !== 1 ||
    b[44] > 18 ||
    b.readUInt32LE(0) > 1 ||
    b.readUInt32LE(46) > 1
  )
    return invalid();
  const extensions = tokenExtensions(b, 1);
  for (const [kind, data] of extensions) {
    if (kind === 1) {
      if (
        data.length !== 108 ||
        data.readUInt16LE(88) > 10000 ||
        data.readUInt16LE(106) > 10000 ||
        data.readBigUInt64LE(72) > data.readBigUInt64LE(90)
      )
        return invalid();
    } else if (kind === 18) {
      if (data.length !== 64) return invalid();
    } else if (kind === 19) metadata(data, mint);
    else
      throw new TokenSetupUnsupported(
        `Account setup does not support ${unsupported[kind] || `token extension ${kind}`} yet.`,
      );
  }
  const transferFee = extensions.has(1);
  return {
    program: TOKEN_2022,
    accountSize: transferFee ? 182 : 170,
    transferFee,
    extensions: [...extensions.keys()].sort((a, b) => a - b),
    mintHash: createHash("sha256").update(b).digest("hex"),
  };
}
export function verifyToken2022Account(
  value: unknown,
  wallet: string,
  mint: string,
  config: TokenSetupConfig,
  empty = false,
) {
  const b = token2022Bytes(value, 182),
    a = record(value);
  if (
    b.length !== config.accountSize ||
    bs58.encode(b.subarray(0, 32)) !== mint ||
    bs58.encode(b.subarray(32, 64)) !== wallet ||
    b[108] !== 1 ||
    b.readUInt32LE(72) !== 0 ||
    b.readUInt32LE(109) !== 0 ||
    b.readBigUInt64LE(121) !== 0n ||
    b.readUInt32LE(129) !== 0 ||
    (empty && b.readBigUInt64LE(64) !== 0n)
  )
    return invalid();
  const ext = tokenExtensions(b, 2);
  if (
    ext.get(7)?.length !== 0 ||
    ext.size !== (config.transferFee ? 2 : 1) ||
    (config.transferFee &&
      (ext.get(2)?.length !== 8 ||
        (empty && ext.get(2)!.readBigUInt64LE(0) !== 0n)))
  )
    return invalid();
  return { lamports: a.lamports as number };
}
