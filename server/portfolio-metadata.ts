import { isMint } from '../src/assets.js';
import { publicProviderJson } from './public-provider-json.js';
export type WalletMetadata = { symbol?: string; name?: string; image?: string };
const artworkHosts = new Set(['cdn.dexscreener.com', 'ipfs.io', 'gateway.pinata.cloud', 'arweave.net', 'image-cdn.solana.fm', 'metadata.pumplify.eu', 'pump.mypinata.cloud', 'cf-ipfs.com', 'fomo-pay.vercel.app', 'www.usefub.app', 'usefub.app']);
const cache = new Map<string, { expires: number; value: WalletMetadata }>();
const clean = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max) : '';
export function walletImage(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const u = new URL(value.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${value.slice(7)}` : value);
    if (u.protocol === 'https:' && artworkHosts.has(u.hostname) && !u.username && !u.password && !u.port && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(u.hostname)) return u.href;
  } catch { /* Missing artwork stays a neutral icon. */ }
}
export function dexWalletMetadata(raw: unknown, mints: Set<string>) {
  const found = new Map<string, WalletMetadata>();
  if (!Array.isArray(raw)) return found;
  // Metadata is useful even before a pair has a price, volume or liquidity.
  for (const p of raw.slice(0, 2000)) {
    if (p?.chainId !== 'solana') continue;
    for (const side of ['baseToken', 'quoteToken']) {
      const t = p[side];
      if (!t || !mints.has(t.address)) continue;
      const old = found.get(t.address) || {};
      found.set(t.address, {
        symbol: old.symbol || clean(t.symbol, 24) || undefined,
        name: old.name || clean(t.name, 80) || undefined,
        image: old.image || (side === 'baseToken' ? walletImage(p.info?.imageUrl) : undefined),
      });
    }
  }
  return found;
}
export async function walletMetadata(mints: string[], rpc: string): Promise<Map<string, WalletMetadata>> {
  const wanted = [...new Set(mints)].filter(isMint).slice(0, 200);
  const found = new Map<string, WalletMetadata>();
  const missing = wanted.filter(mint => {
    const hit = cache.get(mint);
    if (hit && hit.expires > Date.now()) { found.set(mint, hit.value); return false; }
    return true;
  });
  if (!missing.length) return found;
  // DAS supplies original mint metadata, including tokens not indexed by a DEX.
  const results = await Promise.allSettled([
    fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAssetBatch', params: { ids: missing } }), signal: AbortSignal.timeout(4000) }).then(r => publicProviderJson(r, 5_000_000)),
    ...Array.from({ length: Math.ceil(missing.length / 30) }, (_, i) => {
      const batch = missing.slice(i * 30, i * 30 + 30);
      return fetch(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`, { signal: AbortSignal.timeout(4000), redirect: 'error' }).then(r => publicProviderJson(r, 5_000_000)).then(raw => dexWalletMetadata(raw, new Set(batch)));
    }),
  ]);
  const das = results[0];
  if (das.status === 'fulfilled') {
    const body = das.value as { result?: Array<{ id?: string; content?: { metadata?: { name?: string; symbol?: string }; links?: { image?: string }; files?: Array<{ uri?: string; mime?: string }> } }> };
    for (const a of Array.isArray(body?.result) ? body.result : []) {
      if (!a?.id || !missing.includes(a.id)) continue;
      const c = a.content;
      found.set(a.id, { symbol: clean(c?.metadata?.symbol, 24) || undefined, name: clean(c?.metadata?.name, 80) || undefined, image: walletImage(c?.links?.image || c?.files?.find(f => f.mime?.startsWith('image/'))?.uri) });
    }
  }
  for (const result of results.slice(1)) if (result.status === 'fulfilled' && result.value instanceof Map) {
    for (const [mint, value] of result.value) {
      const original = found.get(mint);
      found.set(mint, { symbol: original?.symbol || value.symbol, name: original?.name || value.name, image: original?.image || value.image });
    }
  }
  // Fresh Pump coins can predate market indexing. Use only the fixed provider
  // endpoint and require its mint to match; never fetch a metadata-supplied URL.
  const pumpMissing = missing.filter(mint => !found.get(mint)?.symbol || !found.get(mint)?.image).slice(0, 8);
  await Promise.allSettled(pumpMissing.map(async mint => {
    const data = await fetch(`https://frontend-api-v3.pump.fun/coins-v2/${mint}`, { signal: AbortSignal.timeout(3000), redirect: 'error' }).then(r => publicProviderJson(r, 65536)) as { mint?: string; name?: string; symbol?: string; image_uri?: string };
    if (data?.mint !== mint) return;
    const old = found.get(mint);
    found.set(mint, { symbol: old?.symbol || clean(data.symbol, 24) || undefined, name: old?.name || clean(data.name, 80) || undefined, image: old?.image || walletImage(data.image_uri) });
  }));
  for (const mint of missing) {
    const value = found.get(mint) || {};
    if (cache.size >= 2000) cache.delete(cache.keys().next().value!);
    cache.set(mint, { value, expires: Date.now() + (value.symbol && value.image ? 300_000 : 30_000) });
  }
  return found;
}
