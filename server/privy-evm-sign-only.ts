import { createHash, createPrivateKey, sign } from "node:crypto";
import canonicalize from "canonicalize";
import { isEvmAddress } from "../src/networks.js";
import { cashNetworkByChainId, CASH_GAS_POLICY } from "../src/cash-network-policy.js";
import { inspectSignedCashEvm, type CashEvmTransaction } from "./cash-return-transaction.js";

const BASE = "https://api.privy.io/v1";
export type PrivyEvmSignRequest = {
  walletId: string;
  wallet: string;
  transaction: CashEvmTransaction;
  idempotencyKey: string;
  expiresAt: number;
};
export class PrivyEvmSigningUnavailable extends Error {
  constructor() { super("Provider signing was not confirmed. Do not retry with a new request identity."); }
}
function validateTransaction(tx: CashEvmTransaction, wallet: string) {
  if (!tx || Object.keys(tx).sort().join(',') !== 'chainId,data,from,gas,maxFeePerGas,maxPriorityFeePerGas,nonce,to,type,value' ||
      tx.type !== 'eip1559' || tx.from !== wallet || !isEvmAddress(wallet) || wallet !== wallet.toLowerCase() ||
      !isEvmAddress(tx.to) || /^0x0{40}$/i.test(tx.to) || tx.value !== '0' ||
      !/^0x(?:[0-9a-f]{2}){4,65000}$/i.test(tx.data) || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0 ||
      ![tx.gas,tx.maxFeePerGas,tx.maxPriorityFeePerGas].every(v => typeof v === 'string' && /^(0|[1-9]\d{0,19})$/.test(v))) throw Error();
  const network = cashNetworkByChainId(tx.chainId), policy = CASH_GAS_POLICY[network];
  if (BigInt(tx.gas) < 21000n || BigInt(tx.gas) > 2700000n || BigInt(tx.maxPriorityFeePerGas) > BigInt(tx.maxFeePerGas) ||
      BigInt(tx.maxFeePerGas) <= 0n || BigInt(tx.maxFeePerGas) > BigInt(policy.maxFeePerGas)) throw Error();
}

// Low-level SIGN-ONLY transport, not owner authorization. Keep its credentials in
// the isolated signer. Call only after that service enforces permission and budget.
// Neither the website nor an executor may receive this factory's credentials.
export function privyEvmSignOnly(config: {
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
  return async (request: PrivyEvmSignRequest, signal: AbortSignal): Promise<string> => {
    try {
      const r = structuredClone(request);
      if (Object.keys(r).sort().join(",") !== "expiresAt,idempotencyKey,transaction,wallet,walletId" ||
          !/^[a-z0-9]{20,40}$/.test(r.walletId) || !isEvmAddress(r.wallet) ||
          !/^[A-Za-z0-9:._-]{16,160}$/.test(r.idempotencyKey) ||
          !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= Date.now() || r.expiresAt > Date.now() + 30000) throw Error();
      validateTransaction(r.transaction, r.wallet);
      const combined = AbortSignal.any([signal, AbortSignal.timeout(Math.min(8000, r.expiresAt - Date.now()))]);
      async function json(url: string, init: RequestInit) {
        combined.throwIfAborted();
        const response = await fetcher(url, { ...init, redirect: "error", signal: combined });
        if (!response.ok || !response.body || Number(response.headers.get("content-length")) > 300000) { void response.body?.cancel().catch(() => {}); throw Error(); }
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        // Cancellation must also stop a stalled response body. Do not await a
        // remote stream's cancellation hook: it can itself remain unresolved.
        const cancel = () => { void reader.cancel().catch(() => {}); };
        combined.addEventListener("abort", cancel, { once: true });
        if (combined.aborted) cancel();
        try {
          for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 300000) throw Error(); chunks.push(part.value); }
        } finally { combined.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
        // A complete body may arrive as cancellation fires. Preserve it for
        // signature verification and private journaling; partial JSON fails.
        // The next HTTP call still checks cancellation before accessing Privy.
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      const walletUrl = `${BASE}/wallets/${r.walletId}`;
      const metadata = await json(walletUrl, { headers: { Authorization: auth, "privy-app-id": config.appId } });
      if (metadata.id !== r.walletId || typeof metadata.address !== "string" || metadata.address.toLowerCase() !== r.wallet || metadata.chain_type !== "ethereum") throw Error();
      if (r.expiresAt <= Date.now()) throw Error();
      const url = `${walletUrl}/rpc`;
      const tx = r.transaction;
      const hex = (v: string | number) => '0x' + BigInt(v).toString(16);
      const body = { method: "eth_signTransaction", params: { transaction: {
        type: 2, chain_id: tx.chainId, from: tx.from, to: tx.to, data: tx.data, value: '0x0',
        nonce: tx.nonce, gas_limit: hex(tx.gas), max_fee_per_gas: hex(tx.maxFeePerGas), max_priority_fee_per_gas: hex(tx.maxPriorityFeePerGas),
      } } };
      const headers = {
        "privy-app-id": config.appId,
        "privy-idempotency-key": createHash("sha256").update(`fub-evm-sign-v1:${r.walletId}:${r.idempotencyKey}`).digest("hex"),
        "privy-request-expiry": String(r.expiresAt),
      };
      const payload = canonicalize({ version: 1, method: "POST", url, body, headers });
      if (!payload) throw Error();
      const signature = sign("sha256", Buffer.from(payload), key).toString("base64");
      const result = await json(url, { method: "POST", headers: { ...headers, Authorization: auth, "Content-Type": "application/json", "privy-authorization-signature": signature }, body: JSON.stringify(body) });
      if (result.method !== "eth_signTransaction" || result.data?.encoding !== "rlp" || typeof result.data.signed_transaction !== "string") throw Error();
      await inspectSignedCashEvm(r.transaction, result.data.signed_transaction);
      // Interrupted responses remain uncertain. The service persists a complete
      // signature before checking fresh authority to return it to the executor.
      return result.data.signed_transaction;
    } catch { throw new PrivyEvmSigningUnavailable(); }
  };
}
