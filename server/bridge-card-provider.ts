import type { BridgeCardBinding } from "./bridge-card-wallet.js";
import { isMint } from "../src/assets.js";
import { validMerchantId } from "../src/card-allowance.js";
const id = (s: string) => typeof s === "string" && /^[A-Za-z0-9_-]{1,42}$/.test(s);
// Read-only verification. No account/card creation, funding or card details API.
export function bridgeCardVerifier(apiKey: string, fetcher: typeof fetch = fetch) {
  if (!apiKey || /\s/.test(apiKey)) throw Error("Bridge read credential is missing.");
  return async (binding: BridgeCardBinding) => {
    try {
      if (!id(binding.customerId) || !id(binding.cardId) || !isMint(binding.wallet) || !validMerchantId(binding.merchantId)) throw Error();
      const response = await fetcher(`https://api.bridge.xyz/v0/customers/${binding.customerId}/card_accounts/${binding.cardId}`, {
        headers: { "Api-Key": apiKey, Accept: "application/json" }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000),
      });
      if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 65536) { await response.body?.cancel(); throw Error(); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 65536) throw Error(); chunks.push(part.value); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const card = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (card.id !== binding.cardId || card.customer_id !== binding.customerId || card.status !== "active" ||
          card.crypto_account?.type !== "standard" || card.crypto_account.address !== binding.wallet) throw Error();
      // Deliberately return no PAN, CVC, name, statement or hosted-detail URL.
    } catch { throw Error("An active Bridge card bound to this wallet could not be verified."); }
  };
}
