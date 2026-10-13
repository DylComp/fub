import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import canonicalize from "canonicalize";
import bs58 from "bs58";
import { address, getTransactionDecoder, getTransactionEncoder, getCompiledTransactionMessageDecoder } from "@solana/kit";
import { isMint } from "../src/assets.js";

const BASE = "https://api.privy.io/v1";
export type PrivySignRequest = {
  walletId: string;
  wallet: string;
  unsigned: string;
  idempotencyKey: string;
  expiresAt: number;
};
export class PrivySigningUnavailable extends Error {
  constructor() { super("Provider signing was not confirmed. Do not retry with a new request identity."); }
}
function transaction(value: string) {
  if (typeof value !== "string" || value.length > 1644 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw Error();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > 1232 || bytes.toString("base64") !== value) throw Error();
  const decoded = getTransactionDecoder().decode(bytes);
  if (!Buffer.from(getTransactionEncoder().encode(decoded)).equals(bytes)) throw Error();
  return decoded;
}
export function verifyPrivySignedTransaction(unsigned: string, signed: string, wallet: string) {
  const before = transaction(unsigned), after = transaction(signed);
  const message = getCompiledTransactionMessageDecoder().decode(before.messageBytes);
  if (message.header.numSignerAccounts !== 1 || message.staticAccounts[0] !== wallet ||
      !Buffer.from(before.messageBytes).equals(Buffer.from(after.messageBytes)) ||
      Object.keys(before.signatures).length !== 1 || Object.keys(after.signatures).length !== 1 ||
      (before.signatures[address(wallet)] && before.signatures[address(wallet)]!.some(b => b !== 0))) throw Error();
  const signature = after.signatures[address(wallet)];
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bs58.decode(wallet)]), format: "der", type: "spki" });
  if (!signature || signature.length !== 64 || !verify(null, before.messageBytes, key, signature)) throw Error();
}

// Low-level SIGN-ONLY transport, not owner authorization. Keep its credentials in
// the isolated signer. Call only after that service enforces permission and budget.
// Neither the website nor an executor may receive this factory's credentials.
export function privySignOnly(config: {
  appId: string; appSecret: string; authorizationPrivateKey: string;
  fetcher?: typeof fetch;
}) {
  if (!/^[a-z0-9]{20,40}$/.test(config.appId) || !config.appSecret || /[\s:]/.test(config.appSecret)) throw Error("Invalid provider configuration.");
  let key;
  try {
    key = createPrivateKey({ key: Buffer.from(config.authorizationPrivateKey.replace(/^wallet-auth:/, ""), "base64"), format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw Error();
  } catch { throw Error("Invalid provider authorization key."); }
  const fetcher = config.fetcher || fetch;
  const auth = `Basic ${Buffer.from(`${config.appId}:${config.appSecret}`).toString("base64")}`;
  return async (request: PrivySignRequest, signal: AbortSignal): Promise<string> => {
    try {
      const r = structuredClone(request);
      if (Object.keys(r).sort().join(",") !== "expiresAt,idempotencyKey,unsigned,wallet,walletId" ||
          !/^[a-z0-9]{20,40}$/.test(r.walletId) || !isMint(r.wallet) ||
          !/^[A-Za-z0-9:._-]{16,160}$/.test(r.idempotencyKey) ||
          !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= Date.now() || r.expiresAt > Date.now() + 30000) throw Error();
      const tx = transaction(r.unsigned), message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
      if (message.header.numSignerAccounts !== 1 || message.staticAccounts[0] !== r.wallet ||
          Object.keys(tx.signatures).length !== 1 || (tx.signatures[address(r.wallet)] && tx.signatures[address(r.wallet)]!.some(b => b !== 0))) throw Error();
      const combined = AbortSignal.any([signal, AbortSignal.timeout(Math.min(8000, r.expiresAt - Date.now()))]);
      async function json(url: string, init: RequestInit) {
        combined.throwIfAborted();
        const response = await fetcher(url, { ...init, redirect: "error", signal: combined });
        if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 65536) { void response.body?.cancel().catch(() => {}); throw Error(); }
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        // Cancellation must also stop a stalled response body. Do not await a
        // remote stream's cancellation hook: it can itself remain unresolved.
        const cancel = () => { void reader.cancel().catch(() => {}); };
        combined.addEventListener("abort", cancel, { once: true });
        if (combined.aborted) cancel();
        try {
          for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 65536) throw Error(); chunks.push(part.value); }
        } finally { combined.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
        // A complete body may arrive as cancellation fires. Preserve it for
        // signature verification and private journaling; partial JSON fails.
        // The next HTTP call still checks cancellation before accessing Privy.
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      const walletUrl = `${BASE}/wallets/${r.walletId}`;
      const metadata = await json(walletUrl, { headers: { Authorization: auth, "privy-app-id": config.appId } });
      if (metadata.id !== r.walletId || metadata.address !== r.wallet || metadata.chain_type !== "solana") throw Error();
      if (r.expiresAt <= Date.now()) throw Error();
      const url = `${walletUrl}/rpc`;
      const body = { method: "signTransaction", params: { transaction: r.unsigned, encoding: "base64" } };
      const headers = {
        "privy-app-id": config.appId,
        "privy-idempotency-key": createHash("sha256").update(`fomo-sign-v1:${r.walletId}:${r.idempotencyKey}`).digest("hex"),
        "privy-request-expiry": String(r.expiresAt),
      };
      const payload = canonicalize({ version: 1, method: "POST", url, body, headers });
      if (!payload) throw Error();
      const signature = sign("sha256", Buffer.from(payload), key).toString("base64");
      const result = await json(url, { method: "POST", headers: { ...headers, Authorization: auth, "Content-Type": "application/json", "privy-authorization-signature": signature }, body: JSON.stringify(body) });
      if (result.method !== "signTransaction" || result.data?.encoding !== "base64" || typeof result.data.signed_transaction !== "string") throw Error();
      verifyPrivySignedTransaction(r.unsigned, result.data.signed_transaction, r.wallet);
      // Interrupted responses remain uncertain. The service persists a complete
      // signature before checking fresh authority to return it to the executor.
      return result.data.signed_transaction;
    } catch { throw new PrivySigningUnavailable(); }
  };
}
