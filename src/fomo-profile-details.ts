/** Public profile observations. These never establish ownership or permission. */
export type FomoProfileToken = {
  address: string; chain: string; name: string | null; symbol: string | null; imageUrl: string | null;
};
export type FomoProfilePosition = {
  token: FomoProfileToken; amount: string | null; valueUsd: number | null;
  pnlUsd: number | null; pnlPercent: number | null;
};
export type FomoProfileTrade = { token: FomoProfileToken; pnlUsd: number | null; pnlPercent: number | null };
export type FomoProfileDetails = {
  bio: string | null; following: number | null; joinedAt: number | null; averageHoldingSeconds: number | null;
  portfolioUsd: number | null; portfolioChange24hUsd: number | null; cashUsd: number | null;
  positions: FomoProfilePosition[] | null; topTrades: FomoProfileTrade[] | null;
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown, signed = false) => v === null || typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e15 && (signed || v >= 0);
const text = (v: unknown, max: number) => v === null || typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
/** HTTPS images only; no local resources, URL credentials, or script/data URLs. */
export function fomoTokenImage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const u = new URL(value);
    const allowed = ['cdn.dexscreener.com','prod-fomo-profile-pics.s3.amazonaws.com','pbs.twimg.com','ipfs.io','gateway.pinata.cloud','arweave.net','image-cdn.solana.fm','metadata.pumplify.eu','pump.mypinata.cloud','cf-ipfs.com','metadata.mobula.io','assets.coingecko.com'];
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !allowed.includes(u.hostname)) return null;
    return u.href;
  } catch { return null; }
}
function validToken(v: unknown): v is FomoProfileToken {
  return record(v) && typeof v.address === 'string' && /^[A-Za-z0-9:_-]{1,150}$/.test(v.address) &&
    typeof v.chain === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v.chain) && text(v.name, 100) && text(v.symbol, 40) &&
    (v.imageUrl === null || fomoTokenImage(v.imageUrl) === v.imageUrl);
}
export function validFomoProfileDetails(v: unknown, observedAt: number): v is FomoProfileDetails {
  if (!record(v) || !text(v.bio, 1000) || !(v.following === null || Number.isSafeInteger(v.following) && Number(v.following) >= 0) ||
    !(v.joinedAt === null || Number.isSafeInteger(v.joinedAt) && Number(v.joinedAt) > 0 && Number(v.joinedAt) <= observedAt) ||
    !number(v.averageHoldingSeconds) || !number(v.portfolioUsd) || !number(v.portfolioChange24hUsd, true) || !number(v.cashUsd)) return false;
  if (v.positions !== null && (!Array.isArray(v.positions) || v.positions.length > 100 || !v.positions.every(p => record(p) && validToken(p.token) &&
    (p.amount === null || typeof p.amount === 'string' && /^\d{1,100}(?:\.\d{1,40})?$/.test(p.amount)) && number(p.valueUsd) && number(p.pnlUsd, true) && number(p.pnlPercent, true)))) return false;
  return v.topTrades === null || Array.isArray(v.topTrades) && v.topTrades.length <= 5 && v.topTrades.every(t => record(t) && validToken(t.token) && number(t.pnlUsd, true) && number(t.pnlPercent, true));
}
