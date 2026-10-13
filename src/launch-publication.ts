import { isMint } from "./assets.js";
import { launchDraft } from "./launch-model.js";
import type { LaunchDraft } from "./launch-model.js";
export const LAUNCH_ASSET_ORIGIN = "https://fomo-pay.vercel.app";
export const MAX_LAUNCH_IMAGE_BYTES = 2 * 1024 * 1024;
export type LaunchAuthorization = { version: 1; action: "publish" | "list"; wallet: string; payloadHash: string; nonce: string; issuedAt: number; expiresAt: number };
export type LaunchPublication = { draft: LaunchDraft; recipient: string; imageHash: string; imageType: string; imageBytes: number };
export type PublishedLaunch = { id: string; owner: string; draft: LaunchDraft; recipient: string; imageHash: string; metadataHash: string; imageUrl: string; metadataUrl: string; createdAt: number };
export function publicationPayload(value: LaunchPublication) {
  const draft = launchDraft(value.draft);
  if (!isMint(value.recipient) || !/^[a-f0-9]{64}$/.test(value.imageHash) || !["image/png", "image/jpeg", "image/gif"].includes(value.imageType) ||
      !Number.isSafeInteger(value.imageBytes) || value.imageBytes < 1 || value.imageBytes > MAX_LAUNCH_IMAGE_BYTES) throw Error("Invalid coin image or recipient.");
  return JSON.stringify({ draft, recipient: value.recipient, imageHash: value.imageHash, imageType: value.imageType, imageBytes: value.imageBytes });
}
export function launchAuthorizationMessage(a: LaunchAuthorization, now = Date.now()) {
  if (!a || Object.keys(a).sort().join() !== "action,expiresAt,issuedAt,nonce,payloadHash,version,wallet" || a.version !== 1 ||
      !["publish", "list"].includes(a.action) || !isMint(a.wallet) || !/^[a-f0-9]{64}$/.test(a.payloadHash) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.nonce) ||
      !Number.isSafeInteger(a.issuedAt) || !Number.isSafeInteger(a.expiresAt) || a.issuedAt > now + 30000 ||
      a.expiresAt <= now || a.expiresAt <= a.issuedAt || a.expiresAt - a.issuedAt > 300000) throw Error("Launch authorization expired or invalid.");
  return ["Fub", a.action === "publish" ? "Publish this coin image and metadata; save its launch draft." : "Load my saved launch drafts.",
    "This does not launch a coin, authorize a trade, or transfer funds.", `Site: ${LAUNCH_ASSET_ORIGIN}`, `Wallet: ${a.wallet}`,
    `Payload SHA-256: ${a.payloadHash}`, `Request: ${a.nonce}`, `Issued: ${a.issuedAt}`, `Expires: ${a.expiresAt}`].join("\n");
}
export function launchMetadataKey(hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("Invalid metadata hash.");
  return btoa(String.fromCharCode(...hash.match(/../g)!.map(byte => parseInt(byte, 16))))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function launchMetadataHash(key: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw Error("Invalid metadata address.");
  const hash = Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/") + "="),
    byte => byte.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  if (launchMetadataKey(hash) !== key) throw Error("Noncanonical metadata address.");
  return hash;
}
const legacyLaunchAssetUrl = (kind: "image" | "metadata", hash: string) => `${LAUNCH_ASSET_ORIGIN}/api/launch-assets?kind=${kind}&id=${hash}`;
// The full SHA-256 is retained. Shorter URLs leave room for a maximum-length
// coin name, ticker, permanent split and initial buy in one Solana packet.
export const launchAssetUrl = (kind: "image" | "metadata", hash: string) => kind === "metadata"
  ? `${LAUNCH_ASSET_ORIGIN}/m/${launchMetadataKey(hash)}` : legacyLaunchAssetUrl(kind, hash);
export async function launchHash(bytes: Uint8Array | string) {
  const input = typeof bytes === "string" ? new TextEncoder().encode(bytes) : Uint8Array.from(bytes);
  const hash = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function launchAuthorization(action: LaunchAuthorization["action"], wallet: string, payload: string): Promise<LaunchAuthorization> {
  const now = Date.now();
  return { version: 1, action, wallet, payloadHash: await launchHash(payload), nonce: crypto.randomUUID(), issuedAt: now, expiresAt: now + 300000 };
}
export function validPublishedLaunch(value: unknown, owner: string): value is PublishedLaunch {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const p = value as PublishedLaunch;
    launchDraft(p.draft);
    return p.owner === owner && isMint(p.recipient) && [p.id, p.imageHash, p.metadataHash].every(v => /^[a-f0-9]{64}$/.test(v)) &&
      p.imageUrl === launchAssetUrl("image", p.imageHash) &&
      [launchAssetUrl("metadata", p.metadataHash), legacyLaunchAssetUrl("metadata", p.metadataHash)].includes(p.metadataUrl) && Number.isSafeInteger(p.createdAt);
  } catch { return false; }
}
