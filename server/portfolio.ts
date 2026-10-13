import type { IncomingMessage, ServerResponse } from "node:http";
import { isMint, ADDRESSES } from "../src/assets.js";
import type {
  Holding,
  HoldingsReply,
  ActivityReply,
  WalletTransaction,
} from "../src/portfolio-data.js";
import { walletMetadata } from "./portfolio-metadata.js";
import { walletTransactionDetails } from "./portfolio-activity.js";
import { parseBalance } from "./wallet.js";
export const PROGRAMS = {
  SPL: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "Token 2022": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
} as const;
const U64_MAX = 18446744073709551615n;
export function parseHoldings(
  raw: unknown,
  address: string,
  program: keyof typeof PROGRAMS,
): { holdings: Holding[]; truncated: boolean } {
  const body = raw as { error?: unknown; result?: { value?: unknown } } | null;
  if (body?.error || !Array.isArray(body?.result?.value))
    throw new Error("Unavailable token accounts");
  const entries = body.result.value;
  const seen = new Set<string>();
  const byMint = new Map<string, Holding>();
  let omitted = false;
  for (const entry of entries.slice(0, 5000)) {
    const info = entry?.account?.data?.parsed?.info;
    if (
      !isMint(entry?.pubkey || "") ||
      entry.account?.owner !== PROGRAMS[program] ||
      entry.account?.data?.parsed?.type !== "account" ||
      info?.owner !== address ||
      !isMint(info?.mint || "") ||
      !/^(0|[1-9]\d{0,19})$/.test(info?.tokenAmount?.amount || "") ||
      !Number.isInteger(info?.tokenAmount?.decimals) ||
      info.tokenAmount.decimals < 0 ||
      info.tokenAmount.decimals > 255 ||
      !["initialized", "frozen"].includes(info?.state)
    ) {
      omitted = true;
      continue;
    }
    if (seen.has(entry.pubkey)) continue;
    seen.add(entry.pubkey);
    const amount = BigInt(info.tokenAmount.amount);
    if (amount > U64_MAX) {
      omitted = true;
      continue;
    }
    if (amount === 0n) continue;
    const existing = byMint.get(info.mint);
    if (existing && existing.decimals !== info.tokenAmount.decimals)
      throw new Error("Conflicting token decimals");
    const total = amount + BigInt(existing?.rawAmount || "0");
    if (total > U64_MAX) throw new Error("Invalid aggregate balance");
    byMint.set(info.mint, {
      mint: info.mint,
      program,
      rawAmount: String(total),
      frozenRawAmount: String(
        BigInt(existing?.frozenRawAmount || "0") +
          (info.state === "frozen" ? amount : 0n),
      ),
      decimals: info.tokenAmount.decimals,
      accounts: (existing?.accounts || 0) + 1,
    });
  }
  return {
    holdings: [...byMint.values()].sort((a, b) => a.mint.localeCompare(b.mint)),
    truncated: entries.length > 5000 || omitted,
  };
}
export function parseActivity(raw: unknown): WalletTransaction[] {
  const body = raw as { error?: unknown; result?: unknown } | null;
  if (body?.error || !Array.isArray(body?.result))
    throw new Error("Unavailable activity");
  const seen = new Set<string>();
  return body.result
    .slice(0, 20)
    .map((entry) => {
      if (
        !entry ||
        typeof entry.signature !== "string" ||
        !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(entry.signature) ||
        !Number.isSafeInteger(entry.slot) ||
        entry.slot < 0 ||
        (entry.blockTime !== null &&
          (!Number.isSafeInteger(entry.blockTime) || entry.blockTime < 0)) ||
        !["confirmed", "finalized"].includes(entry.confirmationStatus) ||
        !("err" in entry)
      )
        throw new Error("Invalid activity");
      return {
        signature: entry.signature,
        slot: entry.slot,
        blockTime: entry.blockTime,
        failed: entry.err !== null,
        confirmation: entry.confirmationStatus,
      } as WalletTransaction;
    })
    .filter((entry) => {
      if (seen.has(entry.signature)) return false;
      seen.add(entry.signature);
      return true;
    });
}
async function boundedJson(response: Response) {
  if (!response.ok) throw new Error("Provider unavailable");
  if (Number(response.headers.get("content-length")) > 5_000_000)
    throw new Error("Response too large");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 5_000_000) {
      await reader.cancel();
      throw new Error("Response too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function rpcRead(rpc: string, method: string, params: unknown[]) {
  return boundedJson(
    await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(8000),
    }),
  );
}
async function readHoldings(
  address: string,
  rpc: string,
): Promise<HoldingsReply> {
  const programs = Object.keys(PROGRAMS) as (keyof typeof PROGRAMS)[];
  const parts = await Promise.allSettled([
    rpcRead(rpc, "getBalance", [address, { commitment: "confirmed" }]).then(
      (body) => parseBalance(body, address),
    ),
    ...programs.map((program) =>
      rpcRead(rpc, "getTokenAccountsByOwner", [
        address,
        { programId: PROGRAMS[program] },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]).then((body) => parseHoldings(body, address, program)),
    ),
  ]);
  if (parts.every((part) => part.status === "rejected"))
    throw new Error("Wallet unavailable");
  const result: HoldingsReply = {
    address,
    fetchedAt: Date.now(),
    nativeLamports: null,
    holdings: [],
    missing: [],
    truncated: false,
    metadataUnavailable: false,
  };
  for (const [index, part] of parts.entries()) {
    if (part.status === "rejected") {
      result.missing.push(index === 0 ? "Native SOL" : programs[index - 1]);
      continue;
    }
    if ("lamports" in part.value) result.nativeLamports = part.value.lamports;
    else {
      result.holdings.push(...part.value.holdings);
      result.truncated ||= part.value.truncated;
    }
  }
  result.truncated ||= result.holdings.length > 200;
  result.holdings = result.holdings.slice(0, 200);
  const knownNames: Record<string, { symbol: string; name: string }> = {
    [ADDRESSES.SOL]: { symbol: "wSOL", name: "Wrapped SOL" },
    [ADDRESSES.BONK]: { symbol: "BONK", name: "Bonk" },
    [ADDRESSES.JUP]: { symbol: "JUP", name: "Jupiter" },
  };
  for (const holding of result.holdings) {
    if (knownNames[holding.mint])
      Object.assign(holding, knownNames[holding.mint]);
  }
  const metadata = await walletMetadata(result.holdings.map(h => h.mint), rpc);
  for (const holding of result.holdings) {
    Object.assign(holding, metadata.get(holding.mint));
    if (knownNames[holding.mint]) Object.assign(holding, knownNames[holding.mint]);
  }
  result.metadataUnavailable = result.holdings.some(h => !h.symbol || !h.name);
  return result;
}
const transactionCache = new Map<string, { at: number; raw: unknown }>();
async function readActivity(address: string, rpc: string): Promise<ActivityReply> {
  const transactions = parseActivity(await rpcRead(rpc, "getSignaturesForAddress", [address, { limit: 20, commitment: "confirmed" }]));
  const unread = transactions.filter(t => !t.failed && (!transactionCache.has(t.signature) || Date.now() - transactionCache.get(t.signature)!.at > 300_000));
  // Four bounded batches avoid twenty sequential RPC round trips.
  await Promise.allSettled(Array.from({ length: Math.ceil(unread.length / 5) }, async (_, index) => {
    const batch = unread.slice(index * 5, index * 5 + 5);
    const response = await boundedJson(await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000), body: JSON.stringify(batch.map(t => ({ jsonrpc: '2.0', id: t.signature, method: 'getTransaction', params: [t.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }] }))) }));
    if (!Array.isArray(response)) return;
    for (const item of response) if (batch.some(t => t.signature === item.id) && item.result && !item.error) {
      if (transactionCache.size >= 1000) transactionCache.delete(transactionCache.keys().next().value!);
      transactionCache.set(item.id, { at: Date.now(), raw: item.result });
    }
  }));
  for (const t of transactions) {
    if (t.failed) { t.kind = 'failed'; continue; }
    try { Object.assign(t, walletTransactionDetails(transactionCache.get(t.signature)?.raw, address, t.signature)); }
    catch { t.detailsAvailable = false; }
  }
  const metadata = await walletMetadata(transactions.flatMap(t => (t.movements || []).map(m => m.mint)), rpc);
  for (const t of transactions) for (const m of t.movements || []) if (m.mint !== ADDRESSES.SOL) Object.assign(m, metadata.get(m.mint));
  return { address, fetchedAt: Date.now(), transactions };
}
const cache = new Map<
  string,
  { at: number; data: HoldingsReply | ActivityReply }
>();
const pending = new Map<string, Promise<HoldingsReply | ActivityReply>>();
let windowStart = 0,
  requests = 0;
export async function handlePortfolio(
  req: IncomingMessage,
  res: ServerResponse,
  rpc = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const send = (code: number, data: unknown) => {
    res.statusCode = code;
    res.end(JSON.stringify(data));
  };
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(405, { message: "GET required." });
  }
  const params = new URL(req.url || "/", "http://localhost").searchParams;
  const address = params.get("address") || "",
    view = params.get("view") || "";
  if (
    !isMint(address) ||
    !["holdings", "activity"].includes(view) ||
    params.getAll("address").length !== 1 ||
    params.getAll("view").length !== 1 ||
    [...params.keys()].some((key) => !["address", "view"].includes(key))
  )
    return send(400, {
      message: "Choose a public Solana address and a supported view.",
    });
  const key = `${address}:${view}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 15000) return send(200, cached.data);
  let job = pending.get(key);
  if (!job) {
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (requests >= 20 || pending.size >= 4) {
      res.setHeader("Retry-After", "60");
      return send(429, {
        message: "Wallet reads are busy. Try again in a minute.",
      });
    }
    requests++;
    job = (
      view === "holdings"
        ? readHoldings(address, rpc)
        : readActivity(address, rpc)
    )
      .then((data) => {
        if (cache.size >= 200) cache.delete(cache.keys().next().value!);
        cache.set(key, { data, at: Date.now() });
        return data;
      })
      .finally(() => pending.delete(key));
    pending.set(key, job);
  }
  try {
    return send(200, await job);
  } catch {
    return send(503, {
      message: "Wallet data is unavailable. Try again shortly.",
    });
  }
}
