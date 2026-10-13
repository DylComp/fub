import { neon } from "@neondatabase/serverless";
import type { Rpc } from "./funding.js";
// One bounded read-only scan per 20s on public RPC, 3s on a dedicated endpoint.
// The hosted observer may share a reservation across five plans, capped at
// twenty serialized RPC reads and four request starts/second by copyBatchRpc.
export async function reserveCopyScan(
  url: string,
  endpoint = process.env.SOLANA_RPC_URL,
) {
  const sql = neon(url, {
    fetchOptions: { signal: AbortSignal.timeout(5000) },
  });
  const delay = endpoint ? 3 : 20;
  const rows =
    await sql`INSERT INTO fomo_provider_budget(name,next_at) VALUES('copy-read-scan',clock_timestamp()+${delay}*interval '1 second')
    ON CONFLICT(name) DO UPDATE SET next_at=EXCLUDED.next_at WHERE fomo_provider_budget.next_at<=clock_timestamp() RETURNING name`;
  return rows.length > 0;
}
export function copyReadRpc(
  endpoint = process.env.SOLANA_RPC_URL ||
    "https://api.mainnet-beta.solana.com",
  signal?: AbortSignal,
): Rpc {
  const deadline = Date.now() + 8000;
  return async (method, params) => {
    if (
      ![
        "getGenesisHash",
        "getSignatureStatuses",
        "getBlock",
        "getBlocks",
        "getSlot",
        "getBlockHeight",
        "getFirstAvailableBlock",
        "getSignaturesForAddress",
        "getTransaction",
        "getMultipleAccounts",
      ].includes(method) ||
      signal?.aborted ||
      Date.now() >= deadline
    )
      throw new Error("Activity read budget exhausted.");
    if (method === "getFirstAvailableBlock" && (!Array.isArray(params) || params.length !== 0))
      throw new Error("Invalid source history boundary request.");
    const maxBytes = method === "getBlock" ? 16000000 : 2000000;
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.any([
        AbortSignal.timeout(Math.max(1, Math.min(3000, deadline - Date.now()))),
        ...(signal ? [signal] : []),
      ]),
    });
    if (
      !response.ok ||
      Number(response.headers.get("content-length")) > maxBytes
    )
      throw new Error("Activity provider unavailable.");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing activity response.");
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("Activity response too large.");
      }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      body.jsonrpc !== "2.0" ||
      body.id !== 1 ||
      body.error ||
      !("result" in body)
    )
      throw new Error("Activity provider unavailable.");
    return body.result;
  };
}
