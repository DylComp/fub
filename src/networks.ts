import { isMint } from './assets.js';
import { parseTokenSearch, TOKEN_SEARCH_MAX_LENGTH } from './fomo-token.js';

// Chain IDs are part of asset identity. An EVM address alone does not identify
// a token, and a Solana permission never grants authority on an EVM chain.
export const NETWORKS = {
  solana: { name: 'Solana', family: 'solana', chainId: null, dexId: 'solana', native: 'SOL', probeAmount: '0.01' },
  base: { name: 'Base', family: 'evm', chainId: 8453, dexId: 'base', native: 'ETH', probeAmount: '0.001' },
  bnb: { name: 'BNB Chain', family: 'evm', chainId: 56, dexId: 'bsc', native: 'BNB', probeAmount: '0.01' },
  monad: { name: 'Monad', family: 'evm', chainId: 143, dexId: 'monad', native: 'MON', probeAmount: '10' },
  robinhood: { name: 'Robinhood Chain', family: 'evm', chainId: 4663, dexId: 'robinhood', native: 'ETH', probeAmount: '0.001' },
  arc: { name: 'Arc', family: 'evm', chainId: 5042, dexId: 'arc', native: 'USDC', probeAmount: '1' },
  ethereum: { name: 'Ethereum', family: 'evm', chainId: 1, dexId: 'ethereum', native: 'ETH', probeAmount: '0.001' },
} as const;
export type Network = keyof typeof NETWORKS;
export type EvmNetwork = Exclude<Network, 'solana'>;
export const NETWORK_KEYS = Object.keys(NETWORKS) as Network[];
export const NATIVE_EVM_ADDRESS = '0x0000000000000000000000000000000000000000';
export function isNetwork(value: unknown): value is Network {
  return typeof value === 'string' && Object.hasOwn(NETWORKS, value);
}
export function isEvmAddress(value: string): boolean { return /^0x[0-9a-fA-F]{40}$/.test(value); }
export function assetAddress(chain: Network, value: string): string | null {
  return chain === 'solana' ? (isMint(value) ? value : null) : isEvmAddress(value) ? value.toLowerCase() : null;
}
export function assetKey(chain: Network, address: string): string {
  const normalized = assetAddress(chain, address);
  if (!normalized) throw Error('Invalid token address for this network.');
  return `${chain}:${normalized}`;
}
type NetworkSearch = { chain: Network; query: string; exactAddress?: string; error?: string };
export function parseNetworkTokenSearch(value: string, selected: Network = 'solana'): NetworkSearch {
  const input = value.trim();
  const invalid = (error: string): NetworkSearch => ({ chain: selected, query: '', error });
  if (input.length > TOKEN_SEARCH_MAX_LENGTH || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(input))
    return invalid('Enter a token name, ticker, contract, or Fomo token link.');
  let chain = selected, query = input;
  if (/[:/\\]/.test(input) || /^fomo\.family\b/i.test(input)) {
    const match = /^https:\/\/fomo\.family\/tokens\/(solana|base|bnb|bsc|monad|robinhood|arc|ethereum)\/([^/?#\s]+)\/?(?:[?#][^\s]*)?$/i.exec(input);
    if (!match) return invalid('Use a Fomo token link for one of the listed networks.');
    chain = match[1].toLowerCase() === 'bsc' ? 'bnb' : match[1].toLowerCase() as Network;
    const address = assetAddress(chain, match[2]);
    if (!address) return invalid(`The Fomo link does not contain a valid ${NETWORKS[chain].name} contract.`);
    return { chain, query: address, exactAddress: address };
  }
  if (query.length > 64) return invalid('Token names and tickers must be 64 characters or fewer.');
  if (chain === 'solana') {
    if (/^0x/i.test(query)) return invalid('Choose an EVM network for this contract.');
    const parsed = parseTokenSearch(query);
    return { chain, query: parsed.query, ...(parsed.exactMint ? { exactAddress: parsed.exactMint } : {}), ...(parsed.error ? { error: parsed.error } : {}) };
  }
  if (/^0x/i.test(query)) {
    const address = assetAddress(chain, query);
    return address ? { chain, query: address, exactAddress: address } : invalid('Enter the full 0x contract address.');
  }
  if (isMint(query)) return invalid('Choose Solana for this contract.');
  return { chain, query };
}

export type RouteLeg = {
  venue: string; inputRaw: string; outputRaw: string; minimumRaw: string;
  outputDecimals: number; gasUsd: number | null; feeUsd: number | null;
};
export type NetworkRouteCheck = {
  chain: EvmNetwork; address: string; assetId: string;
  provider: 'lifi' | 'relay';
  status: 'quoted' | 'no-route'; executable: false;
  nativeAmount: string; buy?: RouteLeg; sell?: RouteLeg;
  checkedAt: number; expiresAt: number;
};
