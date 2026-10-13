import type { Rpc } from "./funding.js";
import { setTimeout as wait } from "node:timers/promises";

export type ExecutorRpcDiagnostic = {kind:'http'|'rpc'|'transport'|'malformed';code?:number};
export class ExecutorRpcError extends Error {
  readonly diagnostic:ExecutorRpcDiagnostic;
  constructor(kind:ExecutorRpcDiagnostic['kind'],code?:number){
    super('Executor RPC unavailable. A submitted transaction may still land.');
    this.name='ExecutorRpcError';
    const validCode = typeof code === 'number' && Number.isInteger(code) &&
      ((kind === 'http' && code >= 100 && code <= 599) ||
       (kind === 'rpc' && code >= -32768 && code <= -32000));
    this.diagnostic={kind,...(validCode?{code}:{})};
  }
}
export function executorRpcDiagnostic(error:unknown):ExecutorRpcDiagnostic {
  return error instanceof ExecutorRpcError ? {...error.diagnostic} : {kind:'transport'};
}

const reads = new Set([
  "getGenesisHash",
  "getBlockHeight",
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getFeeForMessage",
  "getMinimumBalanceForRentExemption",
  "isBlockhashValid",
  "getLatestBlockhash",
  "getTokenAccountBalance",
  "simulateTransaction",
]);
// One iteration's bounded execution transport. Recovery has a separate read-only
// transport. Only explicit minimum-context lag on reads may retry, retaining
// the identical slot requirement. Submissions never retry here.
export function executorRpc(endpoint: string, signal: AbortSignal): Rpc {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Invalid execution provider configuration.");
  let requests = 0,
    sent = false;
  return async (method, params) => {
    if (
      signal.aborted ||
      ++requests > 48 ||
      (!reads.has(method) && method !== "sendTransaction")
    )
      throw new Error("Executor RPC request refused.");
    if (method === "sendTransaction") {
      if (sent)
        throw new Error("A send was already attempted in this iteration.");
      sent = true;
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    if (body.length > 64000) throw new Error("Executor RPC request too large.");
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0 && (signal.aborted || ++requests > 48))
          throw new Error("Executor RPC request refused.");
        const response = await fetch(url, {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
        if (!response.ok) throw new ExecutorRpcError('http',response.status);
        if (Number(response.headers.get("content-length")) > 2000000)
          throw new ExecutorRpcError('malformed');
        const reader = response.body?.getReader();
        if (!reader) throw new ExecutorRpcError('malformed');
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 2000000) {
            await reader.cancel();
            throw new ExecutorRpcError('malformed');
          }
          chunks.push(value);
        }
        let reply;
        try { reply = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new ExecutorRpcError('malformed'); }
        if (reads.has(method) && reply?.jsonrpc === "2.0" && reply.id === 1 &&
            reply.error?.code === -32016 && attempt < 2) {
          // A load-balanced RPC node can lag the bank used by the preceding
          // account read. Never lower minContextSlot or reuse an older quote.
          await wait(250 * (attempt + 1), undefined, { signal });
          continue;
        }
        if(reply?.jsonrpc==='2.0'&&reply.id===1&&reply.error)
          throw new ExecutorRpcError('rpc',reply.error.code);
        if (
          !reply ||
          Array.isArray(reply) ||
          reply.jsonrpc !== "2.0" ||
          reply.id !== 1 ||
          reply.error ||
          !("result" in reply)
        )
          throw new ExecutorRpcError('malformed');
        return reply.result;
      }
      throw new Error("Provider context unavailable.");
    } catch (error) {
      if(error instanceof ExecutorRpcError)throw error;
      throw new ExecutorRpcError('transport');
    }
  };
}
