import { enrollmentMessage, type EnrollmentChallenge } from "./signer-enrollment-model";
import { isMint } from "./assets";
export type EnrollmentConfig = { serviceOrigin: string; appId: string; signerId: string; policyId: string; policyDigest: string };
export type EnrollmentIdentity = { wallet: string; walletId: string; userId: string };
export type EnrollmentStatus = { id: string; wallet: string; state: "pending" | "active" | "revoked" | "expired" | "outdated"; expiresAt: number; providerAccess: "unchecked" };
const providerId = /^[a-z0-9]{20,40}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validEnrollmentConfig(c: EnrollmentConfig, webOrigin: string) {
  try {
    const url = new URL(c.serviceOrigin);
    return url.protocol === "https:" && url.origin === c.serviceOrigin && url.origin !== webOrigin &&
      [c.appId, c.signerId, c.policyId].every(v => providerId.test(v)) && /^[0-9a-f]{64}$/.test(c.policyDigest);
  } catch { return false; }
}
export function enrollmentReview(value: unknown, c: EnrollmentConfig, owner: EnrollmentIdentity, origin: string, durationMs: number, now = Date.now()) {
  const v = value as { challenge: EnrollmentChallenge; message: string }, r = v?.challenge;
  if (!validEnrollmentConfig(c, origin) || !r || !uuid.test(r.id) || !isMint(owner.wallet) ||
      r.appId !== c.appId || r.origin !== origin || r.wallet !== owner.wallet || r.walletId !== owner.walletId || r.userId !== owner.userId ||
      r.signerId !== c.signerId || r.policyId !== c.policyId || r.policyDigest !== c.policyDigest ||
      r.issuedAt > now + 5000 || r.challengeExpiresAt <= now || r.issuedAt < now - 300000 ||
      r.expiresAt !== r.issuedAt + durationMs || v.message !== enrollmentMessage(r)) throw Error("The permission review does not match this wallet or Fub's signing policy.");
  return r;
}
export function enrollmentStatus(value: unknown, wallet: string, expectedId?: string): EnrollmentStatus {
  const r = value as EnrollmentStatus;
  if (!r || !uuid.test(r.id) || (expectedId && r.id !== expectedId) || r.wallet !== wallet ||
      !["pending", "active", "revoked", "expired", "outdated"].includes(r.state) || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= 0 ||
      r.providerAccess !== "unchecked") throw Error("The permission response did not match this wallet.");
  return { id: r.id, wallet: r.wallet, state: r.state, expiresAt: r.expiresAt, providerAccess: "unchecked" };
}
export function enrollmentAccess(value: unknown, config: EnrollmentConfig, identity: EnrollmentIdentity, now = Date.now()): 'ready' | 'approval-required' {
  const r = value as Record<string, unknown>;
  if (!r || r.wallet !== identity.wallet || r.walletId !== identity.walletId || r.userId !== identity.userId ||
      r.appId !== config.appId || r.signerId !== config.signerId || r.policyId !== config.policyId || r.policyDigest !== config.policyDigest)
    throw Error('Wallet access configuration changed. Reload Fub before approving access.');
  if (!Number.isSafeInteger(r.checkedAt) || Number(r.checkedAt) > now + 5000 || Number(r.checkedAt) < now - 30000 || !['ready', 'approval-required'].includes(String(r.state)))
    throw Error('Wallet access could not be checked. Try again before approving.');
  return r.state as 'ready' | 'approval-required';
}
export function enrollmentClient(config: EnrollmentConfig, origin: string, getToken: () => Promise<string | null>, current: () => boolean, fetcher = fetch) {
  if (!validEnrollmentConfig(config, origin)) throw Error("Background access is not configured.");
  return async (action: "access" | "prepare" | "activate" | "stop" | "status" | "list" | "position-review" | "position-apply" | "direct-exit-review" | "direct-exit-activate" | "direct-exit-recover" | "direct-exit-list" | "direct-exit-cancel", body: object, signal: AbortSignal): Promise<unknown> => {
    if (!current()) throw Error("Wallet or account changed.");
    const token = await getToken();
    if (!current() || signal.aborted || !token || !/^[A-Za-z0-9_.-]{1,8192}$/.test(token)) throw Error("Sign in again to manage this wallet.");
    const response = await fetcher(`${config.serviceOrigin}/v1/enrollment/${action}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), credentials: "omit", cache: "no-store", redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (response.status===409 && action.startsWith('position-')) { await response.body?.cancel(); throw Error("Stop background access and resolve pending trades, then check the position again."); }
    const maxBytes=action==='direct-exit-list'?262144:65536;
    if (!response.ok || !response.body || Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw Error(action==='direct-exit-review'?"Could not verify this token and balance. Check wallet access and the token contract.":action.startsWith('direct-exit-')?"Order request was not confirmed. Check its status before retrying.":"Permission request was not confirmed. Refresh its status before retrying."); }
    const reader = response.body.getReader(); let size = 0; const parts: Uint8Array[] = [];
    try { for (;;) { const p = await reader.read(); if (p.done) break; size += p.value.length; if (size > maxBytes) throw Error("Permission response was too large."); parts.push(p.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (!current() || signal.aborted) throw Error("Wallet or account changed.");
    const data = new Uint8Array(size); let offset = 0;
    for (const part of parts) { data.set(part, offset); offset += part.length; }
    return JSON.parse(new TextDecoder().decode(data));
  };
}
