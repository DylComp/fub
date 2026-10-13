// Readiness is separate from liveness. Failures abort in-flight signing and
// prevent new grants; owner stop/status endpoints remain available for recovery.
export function signerReadiness(audit: () => Promise<void>, options: { now?: () => number; maxAgeMs?: number } = {}) {
  const now = options.now ?? Date.now, maxAge = options.maxAgeMs ?? 20000;
  let checkedAt: number | null = null, stopped = false;
  let pending: Promise<void> | undefined;
  let generation = new AbortController();
  const invalidate = () => { checkedAt = null; generation.abort(); generation = new AbortController(); };
  const ready = () => !stopped && checkedAt !== null && now() >= checkedAt && now() - checkedAt < maxAge;
  const check = async () => {
    if (stopped) throw Error("Signing service is stopped.");
    if (!pending) {
      pending = (async () => {
        try { await audit(); if (stopped) throw Error(); checkedAt = now(); }
        catch { invalidate(); throw Error("Signing database checks did not pass."); }
      })().finally(() => { pending = undefined; });
    }
    await pending;
  };
  return {
    ready, check,
    async run<T>(action: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
      signal.throwIfAborted();
      await check();
      const active = AbortSignal.any([signal, generation.signal]);
      active.throwIfAborted();
      const result = await action(active);
      active.throwIfAborted();
      await check();
      active.throwIfAborted();
      return result;
    },
    stop() { stopped = true; invalidate(); },
  };
}
