import type { getCompiledTransactionMessageDecoder } from "@solana/kit";
import { isMint } from "./assets.js";
export type CompiledMessage = ReturnType<
  ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]
>;
export type LookupProof = {
  address: string;
  contextSlot: number;
  lastExtendedSlot: number;
  writable: { index: number; address: string }[];
  readonly: { index: number; address: string }[];
};
export const MAX_LOOKUP_TABLES = 4;
export function messageLookups(message: CompiledMessage) {
  if (message.version === 1)
    throw new Error("Unsupported transaction version.");
  const lookups =
    message.version === 0 ? message.addressTableLookups || [] : [];
  if (
    lookups.length > MAX_LOOKUP_TABLES ||
    new Set(lookups.map((l) => String(l.lookupTableAddress))).size !==
      lookups.length
  )
    throw new Error("Unsupported or duplicated address lookup tables.");
  for (const lookup of lookups) {
    const indexes = [...lookup.writableIndexes, ...lookup.readonlyIndexes];
    if (
      !indexes.length ||
      indexes.length > 256 ||
      new Set(indexes).size !== indexes.length ||
      indexes.some((i) => !Number.isInteger(i) || i < 0 || i > 255)
    )
      throw new Error("Invalid address lookup indexes.");
  }
  return lookups;
}
// A review pins only the addresses this message uses, in the chain's writable-then-readonly order.
export function resolveMessageAccounts(
  message: CompiledMessage,
  proofs: LookupProof[] = [],
) {
  if (message.version === 1)
    throw new Error("Unsupported transaction version.");
  const lookups = messageLookups(message),
    statics = message.staticAccounts.map(String);
  if (!Array.isArray(proofs) || proofs.length !== lookups.length)
    throw new Error(
      "Address lookup evidence is missing or does not match the transaction.",
    );
  const writable: string[] = [],
    readonly: string[] = [];
  for (const [i, lookup] of lookups.entries()) {
    const proof = proofs[i];
    if (
      !proof ||
      proof.address !== lookup.lookupTableAddress ||
      !Number.isSafeInteger(proof.contextSlot) ||
      !Number.isSafeInteger(proof.lastExtendedSlot) ||
      proof.lastExtendedSlot < 0 ||
      proof.contextSlot <= proof.lastExtendedSlot
    )
      throw new Error("Address lookup evidence is not finalized and mature.");
    for (const [items, indexes, output] of [
      [proof.writable, lookup.writableIndexes, writable],
      [proof.readonly, lookup.readonlyIndexes, readonly],
    ] as const) {
      if (!Array.isArray(items) || items.length !== indexes.length)
        throw new Error("Address lookup permissions do not match.");
      for (const [n, item] of items.entries()) {
        if (!item || item.index !== indexes[n] || !isMint(item.address))
          throw new Error("Address lookup entry does not match.");
        output.push(item.address);
      }
    }
  }
  const keys = [...statics, ...writable, ...readonly],
    h = message.header;
  if (
    !statics.length ||
    keys.length > 256 ||
    keys.some((k) => !isMint(k)) ||
    new Set(keys).size !== keys.length ||
    !Number.isInteger(h.numSignerAccounts) ||
    h.numSignerAccounts < 1 ||
    h.numSignerAccounts > statics.length ||
    !Number.isInteger(h.numReadonlySignerAccounts) ||
    h.numReadonlySignerAccounts < 0 ||
    h.numReadonlySignerAccounts >= h.numSignerAccounts ||
    !Number.isInteger(h.numReadonlyNonSignerAccounts) ||
    h.numReadonlyNonSignerAccounts < 0 ||
    h.numSignerAccounts + h.numReadonlyNonSignerAccounts > statics.length
  )
    throw new Error("Invalid transaction account permissions.");
  for (const ix of message.instructions) {
    if (
      ix.programAddressIndex <= 0 ||
      ix.programAddressIndex >= statics.length ||
      (ix.accountIndices || []).some((i) => i < 0 || i >= keys.length)
    )
      throw new Error("Transaction instruction has an invalid account index.");
  }
  return { keys, writable, readonly };
}
export function verifyLoadedAddresses(
  message: CompiledMessage,
  proofs: LookupProof[] | undefined,
  loaded: unknown,
  slot: number,
) {
  const resolved = resolveMessageAccounts(message, proofs);
  if (!messageLookups(message).length) return;
  if ((proofs || []).some((p) => p.contextSlot > slot))
    throw new Error("Landed transaction predates its lookup review.");
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded))
    throw new Error("Landed address lookup evidence is missing.");
  const actual = loaded as Record<string, unknown>;
  for (const mode of ["writable", "readonly"] as const) {
    const addresses = actual[mode];
    if (
      !Array.isArray(addresses) ||
      addresses.length !== resolved[mode].length ||
      addresses.some((a, i) => a !== resolved[mode][i])
    )
      throw new Error(
        "Landed address lookups do not match the reviewed transfer.",
      );
  }
}
