import { isMint } from "./assets.js";

// A user-selected profile link, not verified ownership or trading authority.
export type FomoIdentity = {
  source: "user-selected";
  handle: string;
  address: string;
  selectedAt: number;
};
export function fomoHandle(value: string): string | null {
  let handle = value.trim();
  if (handle.length > 200 || /[\u0000-\u001f\u007f]/.test(handle)) return null;
  if (/^https:/i.test(handle)) {
    try {
      const url = new URL(handle);
      if (url.protocol !== "https:" || url.hostname !== "fomo.family" ||
          url.username || url.password || url.port || url.search || url.hash) return null;
      const match = /^\/profile\/([^/]+)\/?$/.exec(url.pathname);
      if (!match) return null;
      handle = decodeURIComponent(match[1]);
    } catch { return null; }
  }
  handle = handle.replace(/^@/, "");
  return /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,39}$/.test(handle) &&
    !isMint(handle) && !/^0x[0-9a-f]{40}$/i.test(handle)
    ? handle.toLowerCase()
    : null;
}
export function fomoProfileUrl(handle: string): string {
  const normalized = fomoHandle(handle);
  if (!normalized) throw new Error("Invalid Fomo username.");
  return `https://fomo.family/profile/${encodeURIComponent(normalized)}`;
}
export function validIdentity(value: unknown, address: string): value is FomoIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as FomoIdentity;
  return Object.keys(row).sort().join(",") === "address,handle,selectedAt,source" &&
    row.source === "user-selected" && typeof row.handle === "string" &&
    /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,39}$/.test(row.handle) &&
    fomoHandle(row.handle) === row.handle &&
    row.address === address && isMint(address) &&
    Number.isSafeInteger(row.selectedAt) && row.selectedAt > 0;
}

// A third-party indexed mapping. This never proves control of the wallet.
export type FomoLookup = {
  source: "fomoapi.dev" | "fomoscan.sh" | "fomo-direct";
  handle: string;
  address: string;
  fetchedAt: number;
  observedAt: number | null;
};
export function validFomoLookup(value: unknown, handle: string): value is FomoLookup {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as FomoLookup;
  return ["fomoapi.dev", "fomoscan.sh", "fomo-direct"].includes(row.source) && row.handle === handle &&
    typeof row.address === "string" && isMint(row.address) &&
    Number.isSafeInteger(row.fetchedAt) && row.fetchedAt > 0 &&
    (row.observedAt === null || (Number.isSafeInteger(row.observedAt) && row.observedAt > 0 && row.observedAt <= row.fetchedAt));
}

export type FomoWalletProof = {
  wallet: string;
  proof: "wallet-signature";
  expiresAt: number;
  profiles: FomoLookup[];
};
export function validFomoWalletProof(value: unknown, wallet: string): value is FomoWalletProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as FomoWalletProof;
  return row.wallet === wallet && isMint(wallet) && row.proof === "wallet-signature" &&
    Number.isSafeInteger(row.expiresAt) && row.expiresAt > Date.now() &&
    row.expiresAt <= Date.now() + 86401000 && Array.isArray(row.profiles) && row.profiles.length <= 20 &&
    new Set(row.profiles.map(profile => profile?.handle)).size === row.profiles.length &&
    row.profiles.every(profile => typeof profile?.handle === "string" && fomoHandle(profile.handle) === profile.handle &&
      validFomoLookup(profile, profile.handle) && profile.address === wallet);
}
