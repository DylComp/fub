import bs58 from "bs58";
import { isMint } from "../src/assets.js";
import { TOKEN_PROGRAM } from "../src/funding-model.js";
import pinned from "../docs/dflow-route-layouts.json" with { type: "json" };

export const DFLOW = pinned.program;
type Shape =
  | string
  | {
      defined?: { name: string };
      vec?: Shape;
      option?: Shape;
      array?: [Shape, number];
    };
type Field = { name: string; type: Shape };
type Variant = { name: string; fields?: (Shape | Field)[] };
type Definition = {
  name: string;
  type: { kind: string; fields?: Field[]; variants?: Variant[] };
};
const definitions = new Map(
  (pinned.types as Definition[]).map((t) => [t.name, t.type]),
);
const metadataActions = new Set([
  "TransferFee",
  "TransferFeeWithMint",
  "TransferFeeV2",
  "TransferFeeWithMintV2",
  "RecordId",
  "RecordId2",
  "IncludeAccount",
  "SetMinimumLegOutputs",
  "SetMinimumLegPrices",
  "SetSponsor",
  "InitAtaIdempotent",
  "SetMaxUnderconsumptionBps",
]);

// Observation only. Decode the complete pinned payload before using finalized
// balance/transfer evidence. These instructions are never accepted for signing.
export function decodeDflowRoute(ix: Record<string, unknown>) {
  try {
    if (
      ix.programId !== DFLOW ||
      typeof ix.data !== "string" ||
      ix.data.length > 1700 ||
      !Array.isArray(ix.accounts) ||
      ix.accounts.length > 256 ||
      ix.accounts.some((a) => typeof a !== "string" || !isMint(a))
    )
      return null;
    const bytes = Buffer.from(bs58.decode(ix.data));
    if (bytes.length > 1232 || bytes.length < 24) return null;
    const layout = pinned.instructions.find((i) =>
      Buffer.from(i.discriminator).equals(bytes.subarray(0, 8)),
    );
    if (
      !layout ||
      ix.accounts.length <= layout.accounts.length ||
      ix.accounts[0] !== TOKEN_PROGRAM ||
      ix.accounts[1] !== "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" ||
      ix.accounts[2] !== "11111111111111111111111111111111" ||
      ix.accounts[layout.accounts.length - 1] !== DFLOW
    )
      return null;
    let cursor = 8,
      budget = 2048;
    const take = (n: number) => {
      if (!Number.isSafeInteger(n) || n < 0 || cursor + n > bytes.length)
        throw Error("Truncated route.");
      const offset = cursor;
      cursor += n;
      return offset;
    };
    const byte = () => bytes[take(1)];
    const count = () => {
      const n = bytes.readUInt32LE(take(4));
      if (n > 64) throw Error("Route vector too large.");
      return n;
    };
    const skip = (shape: Shape, depth = 0): void => {
      if (--budget < 0 || depth > 12) throw Error("Route complexity limit.");
      if (typeof shape === "string") {
        if (shape === "bool") {
          if (byte() > 1) throw Error("Invalid boolean.");
          return;
        }
        const length = (
          { u8: 1, u16: 2, u32: 4, u64: 8, u128: 16, pubkey: 32 } as Record<
            string,
            number
          >
        )[shape];
        if (!length) throw Error("Unsupported route field.");
        take(length);
        return;
      }
      if (shape.vec) {
        for (let n = count(); n; n--) skip(shape.vec, depth + 1);
        return;
      }
      if (shape.array) {
        if (shape.array[1] > 128) throw Error("Unsupported array.");
        for (let n = shape.array[1]; n; n--) skip(shape.array[0], depth + 1);
        return;
      }
      if (shape.option) {
        const tag = byte();
        if (tag > 1) throw Error("Invalid option.");
        if (tag) skip(shape.option, depth + 1);
        return;
      }
      const type = definitions.get(shape.defined?.name || "");
      if (type?.kind === "struct") {
        for (const f of type.fields || []) skip(f.type, depth + 1);
        return;
      }
      if (type?.kind === "enum") {
        const variant = type.variants?.[byte()];
        if (!variant) throw Error("Unknown variant.");
        for (const f of variant.fields || [])
          skip(
            typeof f === "object" && "type" in f ? f.type : (f as Shape),
            depth + 1,
          );
        return;
      }
      throw Error("Unknown route type.");
    };
    const actionCount = count(),
      actions: string[] = [];
    if (!actionCount) return null;
    for (let n = 0; n < actionCount; n++) {
      const tag = byte();
      const action = pinned.actions.find((a) => a.index === tag);
      if (!action) return null;
      actions.push(action.name);
      for (const f of (action as Variant).fields || []) skip(f as Shape);
    }
    const quotedOutput = bytes.readBigUInt64LE(take(8));
    const slippageBps = bytes.readUInt16LE(take(2)),
      platformFeeBps = bytes.readUInt16LE(take(2));
    const feePct = layout.name.startsWith("swap2") ? byte() : 0;
    if (
      cursor !== bytes.length ||
      quotedOutput === 0n ||
      slippageBps > 10000 ||
      platformFeeBps > 10000 ||
      feePct > 100 ||
      actions.every((name) => metadataActions.has(name))
    )
      return null;
    const withDestination = layout.name.endsWith("with_destination");
    return {
      name: `dflow_${layout.name}`,
      authority: ix.accounts[3] as string,
      destination: withDestination ? (ix.accounts[4] as string) : undefined,
      destinationAuthority: withDestination
        ? (ix.accounts[5] as string)
        : undefined,
      outputMint: withDestination ? (ix.accounts[6] as string) : undefined,
      accounts: ix.accounts as string[],
      actions,
    };
  } catch {
    return null;
  }
}
