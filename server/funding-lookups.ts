import { record } from "../src/live-orders.js";
import { isMint } from "../src/assets.js";
import {
  messageLookups,
  resolveMessageAccounts,
} from "../src/lookup-tables.js";
import type { CompiledMessage, LookupProof } from "../src/lookup-tables.js";
import type { Rpc } from "./funding.js";
export const LOOKUP_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
const ACTIVE_SLOT = "18446744073709551615";
export async function resolveFundingLookups(
  message: CompiledMessage,
  rpc: Rpc,
  minContextSlot?: number,
): Promise<LookupProof[]> {
  const lookups = messageLookups(message);
  if (!lookups.length) {
    resolveMessageAccounts(message);
    return [];
  }
  const response = record(
    await rpc("getMultipleAccounts", [
      lookups.map((l) => String(l.lookupTableAddress)),
      {
        encoding: "jsonParsed",
        commitment: "finalized",
        ...(minContextSlot === undefined ? {} : { minContextSlot }),
      },
    ]),
  );
  const contextSlot = record(response.context).slot;
  if (
    !Number.isSafeInteger(contextSlot) ||
    (contextSlot as number) < 1 ||
    (minContextSlot !== undefined &&
      (contextSlot as number) < minContextSlot) ||
    !Array.isArray(response.value) ||
    response.value.length !== lookups.length
  )
    throw new Error("Finalized address lookup evidence is unavailable.");
  const proofs = lookups.map((lookup, index) => {
    const account = record((response.value as unknown[])[index]),
      data = record(account.data),
      parsed = record(data.parsed),
      info = record(parsed.info);
    if (
      account.owner !== LOOKUP_PROGRAM ||
      account.executable !== false ||
      data.program !== "address-lookup-table" ||
      parsed.type !== "lookupTable" ||
      info.deactivationSlot !== ACTIVE_SLOT ||
      (info.authority !== undefined && !isMint(String(info.authority))) ||
      !Array.isArray(info.addresses) ||
      info.addresses.length < 1 ||
      info.addresses.length > 256 ||
      info.addresses.some((a) => typeof a !== "string" || !isMint(a)) ||
      data.space !== 56 + 32 * info.addresses.length ||
      typeof info.lastExtendedSlot !== "string" ||
      !/^(0|[1-9]\d{0,15})$/.test(info.lastExtendedSlot) ||
      !Number.isSafeInteger(Number(info.lastExtendedSlot)) ||
      Number(info.lastExtendedSlot) >= (contextSlot as number) ||
      !Number.isInteger(info.lastExtendedSlotStartIndex) ||
      (info.lastExtendedSlotStartIndex as number) < 0 ||
      (info.lastExtendedSlotStartIndex as number) >= info.addresses.length
    )
      throw new Error(
        "The address lookup table is inactive, unsupported or not mature yet.",
      );
    const addresses = info.addresses as string[];
    const select = (indexes: readonly number[]) =>
      indexes.map((index) => {
        if (index >= addresses.length)
          throw new Error("Address lookup index is unavailable.");
        return { index, address: addresses[index] };
      });
    return {
      address: String(lookup.lookupTableAddress),
      contextSlot: contextSlot as number,
      lastExtendedSlot: Number(info.lastExtendedSlot),
      writable: select(lookup.writableIndexes),
      readonly: select(lookup.readonlyIndexes),
    };
  });
  resolveMessageAccounts(message, proofs);
  return proofs;
}
export async function revalidateFundingLookups(
  message: CompiledMessage,
  proofs: LookupProof[] | undefined,
  rpc: Rpc,
) {
  const pinned = resolveMessageAccounts(message, proofs);
  if (!messageLookups(message).length) return;
  const fresh = await resolveFundingLookups(
    message,
    rpc,
    Math.max(...proofs!.map((p) => p.contextSlot)),
  );
  const current = resolveMessageAccounts(message, fresh);
  if (
    current.keys.length !== pinned.keys.length ||
    current.keys.some((a, i) => a !== pinned.keys[i])
  )
    throw new Error(
      "Address lookup contents changed after review. No submission was made.",
    );
}
