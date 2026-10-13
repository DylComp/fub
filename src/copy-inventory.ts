import { operationId } from "./funding-model.js";
import { CopyValidation } from "./copy-account.js";

export type CopyPosition = {
  id: string;
  name: string;
  version: number;
  revision: string;
  raw: string;
  archived: boolean;
  enabled: boolean;
};
export type CopyAllocation = { id: string; raw: string };
export type InventoryReview = {
  wallet: string;
  id: string;
  mint: string;
  positions: CopyPosition[];
  balanceRaw: string;
  decimals: number;
  slot: number;
  expiresAt: string;
};
export type InventoryEvent = Omit<InventoryReview, "expiresAt"> & {
  allocations: CopyAllocation[];
  createdAt: string;
};
export type InventoryReport = {
  wallet: string;
  tokens: { mint: string; raw: string; plans: number }[];
  hasMore: boolean;
  events: InventoryEvent[];
};
const u64 = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(0|[1-9]\d{0,19})$/.test(value) &&
  BigInt(value) <= 18446744073709551615n;

export function parseAllocations(value: unknown): CopyAllocation[] {
  if (!Array.isArray(value) || !value.length || value.length > 25)
    throw new CopyValidation("Invalid position allocation.");
  const seen = new Set<string>();
  return value
    .map((row) => {
      if (
        !row ||
        typeof row !== "object" ||
        Object.keys(row).sort().join(",") !== "id,raw" ||
        !operationId(row.id) ||
        !u64(row.raw) ||
        seen.has(row.id.toLowerCase())
      )
        throw new CopyValidation("Invalid position allocation.");
      seen.add(row.id.toLowerCase());
      return { id: row.id.toLowerCase() as string, raw: row.raw as string };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function validateAllocation(
  positions: CopyPosition[],
  allocations: CopyAllocation[],
  balance: string,
) {
  if (positions.length !== allocations.length)
    throw new CopyValidation("Include every plan in this balance review.");
  let total = 0n,
    reduced = false;
  for (const position of positions) {
    const next = allocations.find((item) => item.id === position.id);
    if (!next || BigInt(next.raw) > BigInt(position.raw))
      throw new CopyValidation(
        "A correction can only reduce existing copied positions.",
      );
    total += BigInt(next.raw);
    reduced ||= BigInt(next.raw) < BigInt(position.raw);
  }
  if (total > BigInt(balance))
    throw new CopyValidation(
      "The remaining positions exceed the verified token balance.",
    );
  if (!reduced)
    throw new CopyValidation(
      "Reduce at least one position to save a correction.",
    );
}

// Exact decimal editing, including amounts beyond Number.MAX_SAFE_INTEGER.
export function tokenUnits(raw: string, decimals: number) {
  const padded = raw.padStart(decimals + 1, "0");
  if (!decimals) return padded;
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return padded.slice(0, -decimals) + (fraction ? `.${fraction}` : "");
}
export function tokenRaw(value: string, decimals: number) {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    !/^(0|[1-9]\d*)(\.\d+)?$/.test(value) ||
    value.length > 40
  )
    throw new CopyValidation(
      "Enter a token amount without commas or exponents.",
    );
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw new CopyValidation(`This token supports ${decimals} decimal places.`);
  const raw = (whole + fraction.padEnd(decimals, "0")).replace(/^0+(?=\d)/, "");
  if (!u64(raw)) throw new CopyValidation("Token amount is too large.");
  return raw;
}
