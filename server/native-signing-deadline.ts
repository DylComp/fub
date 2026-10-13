// Native signing includes independent simulation, inventory and repeated owner
// checks. Keep every transport inside this one budget and the original review
// expiry. This does not extend leader freshness, permissions or a blockhash.
export const NATIVE_SIGNING_TIMEOUT_MS = 20000;
export const SIGNER_SOCKET_TIMEOUT_MS = NATIVE_SIGNING_TIMEOUT_MS + 5000;
