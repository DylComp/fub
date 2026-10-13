import { isMint } from "./assets.js";

export const TOKEN_SEARCH_MAX_LENGTH = 512;
type TokenSearchInput = { query: string; exactMint?: string; error?: string };

// Parse a public link locally. Never fetch a pasted URL or use its query
// parameters as the token identity.
export function parseTokenSearch(value: string): TokenSearchInput {
  const input = value.trim();
  const invalid = (error: string): TokenSearchInput => ({ query: "", error });
  if (input.length > TOKEN_SEARCH_MAX_LENGTH ||
      /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(input)) {
    return invalid("Enter a token name, ticker, contract, or Fomo token link.");
  }
  if (/[:/\\]/.test(input) || /^fomo\.family\b/i.test(input)) {
    const match = /^https:\/\/fomo\.family\/tokens\/([a-z]+)\/([^/?#\s]+)\/?(?:[?#][^\s]*)?$/i.exec(input);
    if (!match) return invalid("Use a Fomo token link starting with https://fomo.family/tokens/solana/.");
    if (match[1].toLowerCase() !== "solana") {
      return invalid("This token is on another network. Choose a Solana token on Fomo.");
    }
    // Base58 contracts are case-sensitive, including when the URL host is not.
    if (!isMint(match[2])) return invalid("The Fomo link does not contain a valid Solana contract.");
    return { query: match[2], exactMint: match[2] };
  }
  if (input.length > 64) return invalid("Token names and tickers must be 64 characters or fewer.");
  return { query: input, ...(isMint(input) ? { exactMint: input } : {}) };
}

export function fomoTokenUrl(mint: string): string {
  if (!isMint(mint)) throw new Error("Invalid Solana token contract.");
  return `https://fomo.family/tokens/solana/${mint}`;
}
