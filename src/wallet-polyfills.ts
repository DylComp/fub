import { Buffer } from "buffer";

// Privy's Solana confirmation UI uses the Node-compatible Buffer API.
// Load only with wallet setup; leave an existing implementation intact.
globalThis.Buffer ??= Buffer;
