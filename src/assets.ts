export const ADDRESSES: Record<string, string> = {
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  SOL: "So11111111111111111111111111111111111111112",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
};

// Validate a 32-byte base58 address, not just a symbol or arbitrary URL.
export function isMint(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const character of value)
    number = number * 58n + BigInt(alphabet.indexOf(character));
  let bytes = 0;
  while (number > 0n) {
    bytes++;
    number >>= 8n;
  }
  return bytes + (value.match(/^1*/)?.[0].length || 0) === 32;
}

export function mintFor(id: string): string | null {
  return Object.hasOwn(ADDRESSES, id) ? ADDRESSES[id] : isMint(id) ? id : null;
}
export function idFor(mint: string): string {
  return Object.keys(ADDRESSES).find((id) => ADDRESSES[id] === mint) || mint;
}
export const shortAddress = (mint: string) =>
  `${mint.slice(0, 5)}…${mint.slice(-5)}`;
export function priceDecimals(price: number): number {
  return Math.max(2, Math.min(16, 3 - Math.floor(Math.log10(price || 1))));
}
export type DiscoveredToken = {
  chain?: import('./networks.js').Network;
  assetId?: string;
  address: string;
  symbol: string;
  name: string;
  price: number;
  image?: string;
  marketCap?: number | null;
  liquidity: number | null;
  volume: number | null;
};
export type SearchReply = { tokens: DiscoveredToken[]; fetchedAt: number };
