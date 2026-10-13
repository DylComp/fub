import type { PayIssuerStore } from "./pay-issuer-store.js";
import type { payIssuerReader } from "./pay-issuer.js";
export async function reconcilePayBatch(store: PayIssuerStore, reader: ReturnType<typeof payIssuerReader>, maxResources = 5, signal?: AbortSignal) {
  if (!Number.isSafeInteger(maxResources) || maxResources < 1 || maxResources > 20) throw Error("Invalid reconciliation budget.");
  const result = { updated: 0, fenced: 0, retry: 0, unbound: 0, discovery: 0 };
  if (signal?.aborted) return result;
  await reader.verifyAccount(); // Wrong-account credentials never reach a stored snapshot.
  await store.seedDiscovery();
  const stopAt = Date.now() + 40000;
  // One page each tick, persistent cursor and leases let restarts resume the scan.
  const scan = await store.claimDiscovery();
  if (scan) {
    try {
      const page = await reader.list(scan.cardId, scan.kind, scan.cursor || undefined);
      if (signal?.aborted) { await store.failDiscovery(scan); return result; }
      if (await store.finishDiscovery(scan, page.records, page.hasMore)) result.discovery++;
    } catch { await store.failDiscovery(scan); result.retry++; }
  }
  for (let i = 0; i < maxResources && Date.now() < stopAt && !signal?.aborted; i++) {
    const claim = await store.claim();
    if (!claim) break;
    try {
      const record = await reader.read(claim);
      if (signal?.aborted) { await store.fail(claim, "provider_unavailable"); break; }
      if (!await store.bound(record)) { await store.fail(claim, "unbound_card"); result.unbound++; continue; }
      if (await store.finish(claim, record)) result.updated++; else result.fenced++;
    } catch { await store.fail(claim, "provider_unavailable"); result.retry++; }
  }
  return result;
}
