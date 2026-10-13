import { isMint } from "../src/assets.js";
import { record } from "../src/live-orders.js";
import { parsedInfo, SYSTEM } from "./copy-native.js";

// Observation only. These payments never enter swap sizing or follower instructions.
// A recipient must be isolated from the route and its final balance must explain
// every lamport sent to it. No fee-collector identity is inferred from an address.
export function separateNativeTransfers(args: {
  leader: string;
  instructions: Record<string, unknown>[];
  keys: Record<string, unknown>[];
  meta: Record<string, unknown>;
  excluded: Set<string>;
}): Map<number, bigint> {
  const { leader, instructions, keys, meta, excluded } = args;
  const candidates = new Map<number, { destination: string; amount: bigint }>();
  for (const [index, ix] of instructions.entries()) {
    const { type, info } = parsedInfo(ix);
    if (
      ix.programId !== SYSTEM || type !== "transfer" ||
      info.source !== leader || typeof info.destination !== "string" ||
      !isMint(info.destination) || info.destination === leader ||
      excluded.has(info.destination) || !Number.isSafeInteger(info.lamports) ||
      (info.lamports as number) <= 0
    ) continue;
    candidates.set(index, {
      destination: info.destination,
      amount: BigInt(info.lamports as number),
    });
  }
  const accepted = new Map<number, bigint>();
  if (!candidates.size || candidates.size > 4) return accepted;
  if (
    !Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances) ||
    meta.preBalances.length !== keys.length || meta.postBalances.length !== keys.length ||
    !Array.isArray(meta.innerInstructions)
  ) return accepted;
  function mentions(value: unknown, address: string): boolean {
    if (typeof value === "string") return value === address;
    if (Array.isArray(value)) return value.some(v => mentions(v, address));
    if (value && typeof value === "object")
      return Object.values(value).some(v => mentions(v, address));
    return false;
  }
  // Include all inner invocations, not just the supported swap's invocation.
  const inner: unknown[] = [];
  for (const group of meta.innerInstructions) {
    const instructions = record(group).instructions;
    if (!Array.isArray(instructions)) return accepted;
    inner.push(...instructions);
  }
  for (const destination of new Set([...candidates.values()].map(t => t.destination))) {
    const keyIndex = keys.findIndex(k => k.pubkey === destination);
    const key = keys[keyIndex];
    if (!key || key.writable !== true || key.signer !== false) continue;
    const before = meta.preBalances[keyIndex], after = meta.postBalances[keyIndex];
    if (
      !Number.isSafeInteger(before) || before < 0 ||
      !Number.isSafeInteger(after) || after < 0
    ) continue;
    const payments = [...candidates].filter(([, t]) => t.destination === destination);
    const indices = new Set(payments.map(([index]) => index));
    if (
      instructions.some((ix, i) => !indices.has(i) && mentions(ix, destination)) ||
      inner.some(ix => mentions(ix, destination))
    ) continue;
    const total = payments.reduce((sum, [, t]) => sum + t.amount, 0n);
    if (BigInt(after) - BigInt(before) !== total) continue;
    for (const [index, transfer] of payments) accepted.set(index, transfer.amount);
  }
  return accepted;
}
