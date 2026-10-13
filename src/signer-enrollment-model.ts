import { isMint } from "./assets.js";

export type EnrollmentChallenge = {
  version: 1; id: string; appId: string; origin: string; userId: string;
  wallet: string; walletId: string; ownerId: string; signerId: string;
  policyId: string; policyDigest: string; epoch: number;
  issuedAt: number; challengeExpiresAt: number; expiresAt: number;
};
export function enrollmentMessage(c: EnrollmentChallenge): string {
  const id = /^[a-z0-9]{20,40}$/;
  if (c.version !== 1 || !/^[0-9a-f-]{36}$/.test(c.id) || !isMint(c.wallet) ||
      ![c.appId, c.walletId, c.ownerId, c.signerId, c.policyId].every(x => id.test(x)) ||
      !/^did:privy:[a-z0-9]{20,40}$/.test(c.userId) || !/^[0-9a-f]{64}$/.test(c.policyDigest) ||
      ![c.epoch, c.issuedAt, c.challengeExpiresAt, c.expiresAt].every(x => Number.isSafeInteger(x) && x >= 0) ||
      c.challengeExpiresAt <= c.issuedAt || c.challengeExpiresAt > c.issuedAt + 300000 ||
      c.expiresAt <= c.challengeExpiresAt || c.expiresAt > c.issuedAt + 7 * 86400000 ||
      new URL(c.origin).origin !== c.origin || new URL(c.origin).protocol !== "https:") throw Error("Invalid wallet permission review.");
  return ["Fub background signing permission", "", `Site: ${c.origin}`, `App: ${c.appId}`,
    `Account: ${c.userId}`, `Wallet: ${c.wallet}`, `Provider wallet: ${c.walletId}`,
    `Owner: ${c.ownerId}`, `Signer: ${c.signerId}`, `Policy: ${c.policyId}`,
    `Policy fingerprint: ${c.policyDigest}`, `Permission: ${c.id}`, `Revision: ${c.epoch}`,
    `Issued: ${new Date(c.issuedAt).toISOString()}`, `Review expires: ${new Date(c.challengeExpiresAt).toISOString()}`,
    `Access expires: ${new Date(c.expiresAt).toISOString()}`, "",
    "Allow Fub's isolated signer to sign only trades covered by a separate, valid trading permission.",
    "This does not authorize deposits, withdrawals, launches, or changes to wallet ownership.",
    "Stopping Fub blocks new signatures. Already signed transactions may still confirm.",
  ].join("\n");
}
