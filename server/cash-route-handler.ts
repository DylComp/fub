import type { IncomingMessage, ServerResponse } from 'node:http';
import { CASH_NETWORKS, cashAmountRaw, isCashNetwork } from '../src/cash-route.js';
import type { CashRouteQuote } from '../src/cash-route.js';
import { isEvmAddress, NATIVE_EVM_ADDRESS } from '../src/networks.js';
import { quoteCashRoute } from './cash-route.js';

// Quote probes only. No user identity is inferred from these public addresses,
// and neither a transaction nor an approval can be obtained from this handler.
const SOURCE = 'FUBX2ib5W4NeGpq1fmnf71eqAH2xZPrA7skTYNSZ1146';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
const cache = new Map<string, CashRouteQuote>();
const pending = new Map<string, Promise<CashRouteQuote>>();
let windowStart = 0, requests = 0;
export async function handleCashRoute(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
  const send = (status: number, body: unknown) => { res.statusCode = status; res.end(JSON.stringify(body)); };
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(405, { message: 'GET required.' }); }
  const p = new URL(req.url || '/', 'https://localhost').searchParams;
  const network = p.get('chain'), token = p.get('cash') || '';
  let amountRaw: string;
  try { amountRaw = cashAmountRaw(p.get('amount') || ''); }
  catch { return send(400, { message: 'Enter between 1 and 10,000 USDC with up to six decimal places.' }); }
  if (!isCashNetwork(network) || !isEvmAddress(token) || token.toLowerCase() === NATIVE_EVM_ADDRESS ||
    ['chain', 'cash', 'amount'].some(k => p.getAll(k).length !== 1) || [...p.keys()].some(k => !['chain', 'cash', 'amount'].includes(k)))
    return send(400, { message: 'Choose a network and token contract.' });
  const key = `${CASH_NETWORKS[network].chainId}:${token.toLowerCase()}:${amountRaw}`, hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return send(200, hit);
  let task = pending.get(key);
  if (!task) {
    if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); requests = 0; }
    if (requests >= 30 || pending.size >= 4) { res.setHeader('Retry-After', '60'); return send(429, { message: 'Quotes are busy. Try again in a minute.' }); }
    requests++;
    task = quoteCashRoute({ sourceWallet: SOURCE, recipient: RECIPIENT, network, token: token.toLowerCase(), amountRaw, slippageBps: 100 });
    pending.set(key, task);
  }
  try {
    const result = await task;
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    cache.set(key, result); return send(200, result);
  } catch (error) {
    if (process.env.NODE_ENV === 'development') console.warn('Cash quote check:', error instanceof Error ? error.message : 'Invalid response');
    return send(503, { message: 'A verified USDC quote is unavailable for this token and amount. Try again shortly.' });
  }
  finally { pending.delete(key); }
}
