import { setTimeout as delay } from "node:timers/promises";
import type { Rpc } from "./funding.js";

// One observer batch gets a finite read budget. Only identical finalized reads
// share evidence, and only for this batch. Cursors and receipts remain per plan.
export function copyBatchRpc(read: Rpc, parent?: AbortSignal) {
  const controller = new AbortController();
  const signal = parent
    ? AbortSignal.any([parent, controller.signal])
    : controller.signal;
  const deadline = Date.now() + 8000;
  const cache = new Map<string, Promise<unknown>>();
  let tail: Promise<unknown> = Promise.resolve();
  let lastStarted = 0, requests = 0, shared = 0;
  const rpc: Rpc = async (method, params) => {
    if (signal.aborted || Date.now() >= deadline)
      throw new Error("Observer batch read budget exhausted.");
    const options = params[method === "getSlot" ? 0 : 1];
    if (
      !["getSlot", "getSignaturesForAddress", "getTransaction"].includes(method) ||
      !options || typeof options !== "object" ||
      (options as Record<string, unknown>).commitment !== "finalized"
    ) throw new Error("Observer batches only accept finalized activity reads.");
    const key = JSON.stringify([method, params]);
    let pending = cache.get(key);
    if (pending) shared++;
    else {
      // Five plans can each need one discovery read and three pending receipts.
      if (cache.size >= 20) throw new Error("Observer batch read budget exhausted.");
      pending = tail.catch(() => {}).then(async () => {
        if (signal.aborted || Date.now() >= deadline)
          throw new Error("Observer batch stopped.");
        const pause = Math.max(0, lastStarted + 250 - Date.now());
        if (pause) await delay(pause, undefined, { signal });
        if (signal.aborted || Date.now() >= deadline)
          throw new Error("Observer batch stopped.");
        lastStarted = Date.now();
        requests++;
        return read(method, params);
      });
      // FIFO admission prevents a busy leader from using all RPC starts before
      // other plans get their first read. Failed evidence is not retried here.
      tail = pending;
      cache.set(key, pending);
    }
    const result = await pending;
    if (signal.aborted) throw new Error("Observer batch stopped.");
    return structuredClone(result);
  };
  return {
    rpc,
    close: () => controller.abort(),
    stats: () => ({ requests, shared }),
  };
}
