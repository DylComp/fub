import { EnrollmentRefused } from './privy-owner.js';
import { signerEnrollmentStore, type SignerEnrollmentStore } from './signer-enrollment-store.js';

// Use the signer's canonical active-grant lookup. Activation increments the
// wallet epoch, so an active challenge's epoch is one behind the wallet epoch.
export async function pilotOwnerStatus(databaseUrl: string, wallet: string, store: Pick<SignerEnrollmentStore, 'active'> = signerEnrollmentStore(databaseUrl)) {
  try {
    const row = await store.active(wallet);
    return { active: 1, expiresAt: row.challenge.expiresAt };
  } catch (error) {
    if (error instanceof EnrollmentRefused) return { active: 0, expiresAt: null };
    // An unavailable database is not proof of an absent owner approval.
    throw error;
  }
}
