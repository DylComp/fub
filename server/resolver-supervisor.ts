// Browser failures must not leave the lookup host permanently stopped. Backoff
// limits upstream traffic; a restart does not clear provider pauses or queue caps.
export async function superviseResolver(
  run: () => Promise<void>, signal: AbortSignal,
  deps: {
    now: () => number;
    wait: (ms: number, signal: AbortSignal) => Promise<void>;
    report: (delayMs: number) => void;
  },
) {
  let failures = 0;
  while (!signal.aborted) {
    const started = deps.now();
    try { await run(); } catch { /* Child diagnostics contain fixed reason codes. */ }
    if (signal.aborted) break;
    failures = deps.now() - started >= 600000 ? 1 : Math.min(failures + 1, 5);
    const backoff = Math.min(300000, 20000 * 2 ** (failures - 1));
    deps.report(backoff);
    try { await deps.wait(backoff, signal); } catch { if (signal.aborted) break; throw Error('Resolver restart timer failed.'); }
  }
}
