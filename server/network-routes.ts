import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { assetAddress, assetKey, isNetwork, NATIVE_EVM_ADDRESS, NETWORKS } from '../src/networks.js';
import type { EvmNetwork, NetworkRouteCheck, RouteLeg } from '../src/networks.js';
import { publicProviderJson } from './public-provider-json.js';

// These are indicative quotes, not an execution adapter. No caller wallet,
// secret, allowance, calldata, or signing request is exposed by this endpoint.
const PROBE_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const UINT = /^(0|[1-9][0-9]{0,77})$/;
const raw = (v: unknown): bigint => {
  if (typeof v !== 'string' || !UINT.test(v) || BigInt(v) >= 2n ** 256n) throw Error('Invalid quote amount.');
  return BigInt(v);
};
const sameAddress = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const money = (v: unknown): number | null => {
  if ((typeof v !== 'number' && typeof v !== 'string') || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Invalid quote response.');
  return v as ObjectValue;
};
function cost(items: unknown): number | null {
  if (!Array.isArray(items) || items.length > 20) return null;
  let total = 0;
  for (const item of items) {
    const value = money(object(item).amountUSD);
    if (value === null) return null;
    total += value;
  }
  return Number.isFinite(total) ? total : null;
}
export function inspectNetworkQuote(value: unknown, chain: EvmNetwork, input: string, output: string, amount: string): RouteLeg {
  const v = object(value), action = object(v.action), estimate = object(v.estimate);
  const source = object(action.fromToken), destination = object(action.toToken);
  const chainId = NETWORKS[chain].chainId;
  if (v.type !== 'lifi' || action.fromChainId !== chainId || action.toChainId !== chainId ||
    source.chainId !== chainId || destination.chainId !== chainId ||
    !sameAddress(source.address, input) || !sameAddress(destination.address, output) ||
    !sameAddress(action.fromAddress, PROBE_ADDRESS) || !sameAddress(action.toAddress, PROBE_ADDRESS) ||
    action.fromAmount !== amount || estimate.fromAmount !== amount || action.slippage !== 0.01 ||
    typeof v.tool !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(v.tool) ||
    !Number.isInteger(destination.decimals) || Number(destination.decimals) < 0 || Number(destination.decimals) > 36)
    throw Error('Quote identity does not match the request.');
  // A same-chain request must not silently produce a bridge or a deposit into
  // another protocol. Fee collection and wrapping may accompany a spot swap.
  if (!Array.isArray(v.includedSteps) || v.includedSteps.length < 1 || v.includedSteps.length > 12)
    throw Error('Invalid quote steps.');
  for (const item of v.includedSteps) {
    const step = object(item), a = object(step.action);
    if (a.fromChainId !== chainId || a.toChainId !== chainId ||
      !(step.type === 'swap' || step.type === 'protocol' && ['feeCollection', 'wrapper'].includes(String(step.tool))))
      throw Error('Quote contains an unsupported step.');
  }
  const expected = raw(estimate.toAmount), minimum = raw(estimate.toAmountMin);
  if (raw(amount) === 0n || expected === 0n || minimum === 0n || minimum > expected || minimum < expected * 99n / 100n)
    throw Error('Quote minimum exceeds the requested slippage.');
  return { venue: v.tool, inputRaw: amount, outputRaw: expected.toString(), minimumRaw: minimum.toString(),
    outputDecimals: Number(destination.decimals), gasUsd: cost(estimate.gasCosts), feeUsd: cost(estimate.feeCosts) };
}
export function inspectRelayQuote(value: unknown, chain: EvmNetwork, input: string, output: string, amount: string): RouteLeg {
  const v = object(value), details = object(v.details), source = object(details.currencyIn), destination = object(details.currencyOut);
  const sourceToken = object(source.currency), destinationToken = object(destination.currency), chainId = NETWORKS[chain].chainId;
  if (details.operation !== 'swap' || !sameAddress(details.sender, PROBE_ADDRESS) || !sameAddress(details.recipient, PROBE_ADDRESS) ||
    sourceToken.chainId !== chainId || destinationToken.chainId !== chainId ||
    !sameAddress(sourceToken.address, input) || !sameAddress(destinationToken.address, output) || source.amount !== amount ||
    object(details.slippageTolerance).total !== '99' || !Number.isInteger(destinationToken.decimals) ||
    Number(destinationToken.decimals) < 0 || Number(destinationToken.decimals) > 36)
    throw Error('Quote identity does not match the request.');
  if (!Array.isArray(v.steps) || v.steps.length < 1 || v.steps.length > 4) throw Error('Invalid quote steps.');
  for (const item of v.steps) {
    const step = object(item);
    if (step.kind !== 'transaction' || !['approve', 'swap'].includes(String(step.id)) || !Array.isArray(step.items) || step.items.length < 1 || step.items.length > 4)
      throw Error('Quote contains an unsupported step.');
    for (const part of step.items) if (object(object(part).data).chainId !== chainId) throw Error('Wrong-chain quote step.');
  }
  const expected = raw(destination.amount), minimum = raw(destination.minimumAmount);
  if (raw(amount) === 0n || expected === 0n || minimum === 0n || minimum > expected || minimum < expected * 99n / 100n)
    throw Error('Quote minimum exceeds the requested slippage.');
  const fees = object(v.fees), relayer = money(object(fees.relayer).amountUsd), app = money(object(fees.app).amountUsd);
  return { venue: 'Relay', inputRaw: amount, outputRaw: expected.toString(), minimumRaw: minimum.toString(),
    outputDecimals: Number(destinationToken.decimals), gasUsd: money(object(fees.gas).amountUsd),
    feeUsd: relayer === null || app === null ? null : relayer + app };
}
export async function checkNetworkRoute(chain: EvmNetwork, address: string, fetcher: typeof fetch = fetch, now = Date.now): Promise<NetworkRouteCheck> {
  const normalized = assetAddress(chain, address);
  if (!normalized || normalized === NATIVE_EVM_ADDRESS) throw Error('Enter a token contract.');
  const started = now(), { chainId, probeAmount } = NETWORKS[chain];
  const [whole, fraction = ''] = probeAmount.split('.');
  const amount = (BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))).toString();
  const signal = AbortSignal.timeout(12000);
  const quote = async (input: string, output: string, inputRaw: string): Promise<RouteLeg | null> => {
    // Keep one basis point of rounding headroom; the verifier still requires
    // at least 99% of the quoted output, the user's full 1% bound.
    if (['monad','robinhood','arc'].includes(chain)) {
      const request: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.RELAY_API_KEY ? {'x-api-key':process.env.RELAY_API_KEY} : {}) },
        body: JSON.stringify({ user: PROBE_ADDRESS, recipient: PROBE_ADDRESS, originChainId: chainId, destinationChainId: chainId,
          originCurrency: input, destinationCurrency: output, amount: inputRaw, tradeType: 'EXACT_INPUT', slippageTolerance: '99' }),
        signal, redirect: 'error', cache: 'no-store' };
      let response = await fetcher('https://api.relay.link/quote/v2', request);
      // A short provider throttle should not discard a successful first leg.
      // Retry only this read-only quote, once, inside the original deadline.
      if (response.status === 429) {
        const retry = response.headers.get('retry-after');
        const wait = retry === null ? 1000 : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : NaN;
        if (Number.isFinite(wait) && wait <= 3000) {
          await response.body?.cancel();
          await delay(Math.max(250, wait), undefined, { signal });
          response = await fetcher('https://api.relay.link/quote/v2', request);
        }
      }
      if (response.status === 400) {
        // Parse only a bounded public error. Authentication, throttling and
        // provider failures must not be presented as absence of a market.
        const failure = object(await publicProviderJson(new Response(response.body, { status: 200 })));
        if (['NO_QUOTES', 'NO_SWAP_ROUTES_FOUND', 'NO_INTERNAL_SWAP_ROUTES_FOUND', 'INSUFFICIENT_LIQUIDITY', 'AMOUNT_TOO_LOW', 'UNSUPPORTED_CURRENCY'].includes(String(failure.errorCode))) return null;
        throw Error('Quote provider unavailable.');
      }
      return inspectRelayQuote(await publicProviderJson(response), chain, input, output, inputRaw);
    }
    const params = new URLSearchParams({ fromChain: String(chainId), toChain: String(chainId), fromToken: input, toToken: output,
      fromAmount: inputRaw, fromAddress: PROBE_ADDRESS, toAddress: PROBE_ADDRESS, slippage: '0.01' });
    const response = await fetcher(`https://li.quest/v1/quote?${params}`, { signal, redirect: 'error', cache: 'no-store' });
    // A 404 is the provider's no-quote response. Outages/rate limits are errors,
    // not evidence that the token cannot trade.
    if (response.status === 404) { await response.body?.cancel(); return null; }
    return inspectNetworkQuote(await publicProviderJson(response), chain, input, output, inputRaw);
  };
  const buy = await quote(NATIVE_EVM_ADDRESS, normalized, amount);
  const sell = buy ? await quote(normalized, NATIVE_EVM_ADDRESS, buy.minimumRaw) : null;
  const checkedAt = now();
  if (checkedAt < started || checkedAt - started > 13000) throw Error('Quote check timed out.');
  return { chain, address: normalized, assetId: assetKey(chain, normalized), nativeAmount: probeAmount, provider: ['monad','robinhood','arc'].includes(chain) ? 'relay' : 'lifi',
    status: buy && sell ? 'quoted' : 'no-route', executable: false,
    ...(buy ? { buy } : {}), ...(sell ? { sell } : {}), checkedAt, expiresAt: checkedAt + 30000 };
}
const cache = new Map<string, NetworkRouteCheck>();
const pending = new Map<string, Promise<NetworkRouteCheck>>();
let windowStart = 0, requests = 0;
export async function handleNetworkRoute(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  const send = (status: number, body: unknown) => { res.statusCode = status; res.end(JSON.stringify(body)); };
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(405, { message: 'GET required.' }); }
  const params = new URL(req.url || '/', 'https://localhost').searchParams;
  const chain = params.get('chain'), address = params.get('route') || '';
  if (!isNetwork(chain) || chain === 'solana' || params.getAll('chain').length !== 1 || params.getAll('route').length !== 1 ||
    [...params.keys()].some(k => k !== 'chain' && k !== 'route') || !assetAddress(chain, address) || address === NATIVE_EVM_ADDRESS)
    return send(400, { message: 'Choose an EVM network and enter a token contract.' });
  const key = assetKey(chain, address), hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return send(200, hit);
  let task = pending.get(key);
  if (!task) {
    if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); requests = 0; }
    if (requests >= 30 || pending.size >= 4) { res.setHeader('Retry-After', '60'); return send(429, { message: 'Route checks are busy. Try again in a minute.' }); }
    requests++;
    task = checkNetworkRoute(chain, address);
    pending.set(key, task);
  }
  try {
    const result = await task;
    if (cache.size >= 200) cache.delete(cache.keys().next().value!);
    cache.set(key, result);
    return send(200, result);
  } catch { return send(503, { message: 'Route check unavailable. Try again shortly.' }); }
  finally { pending.delete(key); }
}
