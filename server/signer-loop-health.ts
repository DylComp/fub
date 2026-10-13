// Operator-only health, without wallet identifiers, errors, credentials or bytes.
// Database readiness alone cannot establish that the background loops are alive.
export function signerLoopHealth(maxAgeMs: number, now: () => number = Date.now) {
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000) throw Error('Invalid loop health window.');
  const startedAt = now();
  let runningSince: number | null = null, completedAt: number | null = null;
  let succeededAt: number | null = null, consecutiveFailures = 0, iterations = 0;
  let counts = { checked: 0, settled: 0, expired: 0, pending: 0, refused: 0 };
  return {
    begin() {
      if (runningSince !== null) return false;
      runningSince = now(); return true;
    },
    complete(result: Partial<typeof counts>) {
      const next = { checked: 0, settled: 0, expired: 0, pending: 0, refused: 0, ...result };
      if (runningSince === null || Object.keys(next).sort().join(',') !== 'checked,expired,pending,refused,settled' ||
        Object.values(next).some(n => !Number.isSafeInteger(n) || n < 0)) throw Error('Invalid loop completion.');
      completedAt = now(); runningSince = null; iterations++; counts = next;
      if (next.refused) consecutiveFailures++;
      else { consecutiveFailures = 0; succeededAt = completedAt; }
    },
    fail() {
      completedAt = now(); runningSince = null; iterations++; consecutiveFailures++;
    },
    snapshot(enabled: boolean) {
      const age = now() - (completedAt ?? startedAt);
      const stalled = age < 0 || age > maxAgeMs ||
        (runningSince !== null && (now() < runningSince || now() - runningSince > maxAgeMs));
      const status = !enabled ? 'disabled' : stalled ? 'stalled' : consecutiveFailures ? 'degraded' : completedAt === null ? 'starting' : 'healthy';
      return { status, running: runningSince !== null, completedAt, succeededAt, iterations, consecutiveFailures, counts: { ...counts } };
    },
  };
}
