import {FUB_CANONICAL_ORIGIN} from '../src/fub-origin.js';
import {verifyLaunchSession} from './launch-session.js';
import {isFubWebOrigin} from './fub-web-origin.js';
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, createPublicKey, verify } from "node:crypto";
import { address, isOffCurveAddress } from "@solana/kit";
import bs58 from "bs58";
import { launchDraft } from "../src/launch-model.js";
import { launchAuthorizationMessage, publicationPayload, launchAssetUrl, launchMetadataHash, MAX_LAUNCH_IMAGE_BYTES } from "../src/launch-publication.js";
import type { LaunchAuthorization, PublishedLaunch } from "../src/launch-publication.js";
import { normalizeLaunchImage } from "./launch-image.js";
import { freshLaunchRecipient } from "./launch-api.js";
import { launchPublicationStore, PublicationPending } from "./launch-publication-store.js";
import type { LaunchPublicationStore } from "./launch-publication-store.js";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const exact = (o: unknown, keys: string) => !!o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join() === keys;
export function verifyLaunchAuthorization(a: LaunchAuthorization, signature: string, payload: string) {
  const message = launchAuthorizationMessage(a);
  if (a.payloadHash !== hash(payload) || typeof signature !== "string" || signature.length > 88 || isOffCurveAddress(address(a.wallet))) throw Error("Invalid launch signature.");
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(bs58.decode(a.wallet))]), format: "der", type: "spki" });
  const bytes = bs58.decode(signature);
  if (bytes.length !== 64 || bs58.encode(bytes) !== signature || !verify(null, Buffer.from(message), key, bytes)) throw Error("Invalid launch signature.");
}
async function body(req: IncomingMessage) {
  const max = 2820000, parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (Number(req.headers["content-length"]) > max) throw Error("Upload too large.");
  if (parsed !== undefined) {
    const text = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    if (Buffer.byteLength(text) > max) throw Error("Upload too large.");
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  }
  const timer = setTimeout(() => req.destroy(), 5000), chunks: Buffer[] = []; let size = 0;
  try {
    for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > max) throw Error("Upload too large."); chunks.push(b); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { clearTimeout(timer); }
}
export function launchPublicationHandler(options: { store?: () => LaunchPublicationStore; lookup?: typeof freshLaunchRecipient } = {}) {
  let pending = 0;
  const storage = options.store || (() => { if (!process.env.DATABASE_URL) throw Error("Storage unavailable"); return launchPublicationStore(process.env.DATABASE_URL); });
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    const send = (status: number, data: unknown) => { res.statusCode = status; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(data)); };
    const url = new URL(req.url || "/", "https://localhost"), query = url.searchParams;
    const compactPath = url.pathname.startsWith("/m/");
    if ((compactPath || query.has("metadataKey")) && req.method !== "GET") {
      res.setHeader("Allow", "GET"); return send(405, { message: "GET required." });
    }
    if (req.method === "GET") {
      let kind = query.get("kind"), id = query.get("id");
      try {
        if (compactPath || query.has("metadataKey")) {
          const key = compactPath ? url.pathname.slice(3) : query.get("metadataKey")!;
          if (query.size && ([...query.keys()].join() !== "metadataKey" || query.get("metadataKey") !== key)) throw Error();
          kind = "metadata"; id = launchMetadataHash(key);
        } else if ([...query.keys()].sort().join() !== "id,kind" || !["image", "metadata"].includes(kind || "") || !/^[a-f0-9]{64}$/.test(id || "")) throw Error();
      } catch { return send(400, { message: "Invalid asset address." }); }
      try {
        const asset = await storage().asset(kind as "image" | "metadata", id!);
        if (!asset) return send(404, { message: "Asset not found." });
        res.setHeader("Content-Type", asset.type); res.setHeader("Content-Length", asset.bytes.length);
        res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); res.setHeader("ETag", `"${id}"`);
        res.statusCode = 200; res.end(asset.bytes); return;
      } catch { return send(503, { message: "Published asset temporarily unavailable." }); }
    }
    if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return send(405, { message: "GET or POST required." }); }
    if (query.size) return send(400, { message: "Invalid publication request." });
    if (!isFubWebOrigin(req.headers.origin) ||
        req.headers["x-fomo-request"] !== "1" || req.headers["content-type"]?.split(";")[0] !== "application/json" ||
        (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) return send(403, { message: "Open this action from Fub." });
    if (pending >= 2) { res.setHeader("Retry-After", "30"); return send(429, { message: "Image processing is busy. Try again shortly." }); }
    pending++;
    let reserved: LaunchAuthorization | undefined, store: LaunchPublicationStore | undefined;
    try {
      let raw, a: LaunchAuthorization, draft, recipient = "", bytes = Buffer.alloc(0), type = "", signedPayload = "";
      try {
        raw = await body(req);
        if (!exact(raw, "authorization,payload,signature")) throw Error();
        a = raw.authorization;
        launchAuthorizationMessage(a);
        if (a.action === "list") {
          if (!exact(raw.payload, "")) throw Error();
          signedPayload = "{}";
        } else {
          if (!exact(raw.payload, "draft,image,recipient") || !exact(raw.payload.image, "data,type")) throw Error();
          draft = launchDraft(raw.payload.draft); recipient = raw.payload.recipient; type = raw.payload.image.type;
          const encoded = raw.payload.image.data;
          if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_LAUNCH_IMAGE_BYTES / 3) * 4) throw Error();
          bytes = Buffer.from(encoded, "base64");
          if (bytes.toString("base64") !== encoded || isOffCurveAddress(address(recipient))) throw Error();
          signedPayload = publicationPayload({ draft, recipient, imageHash: hash(bytes), imageType: type, imageBytes: bytes.length });
        }
        if(a.payloadHash!==hash(signedPayload))throw Error();
        if(!verifyLaunchSession(req,a.wallet,raw.signature))verifyLaunchAuthorization(a, raw.signature, signedPayload);
      } catch { return send(400, { message: "Check the signed coin draft and image, then try again." }); }
      store = storage();
      if (a.action === "list") return send(200, { publications: await store.list(a.wallet) });
      const previous = await store.reserve(a, raw.signature, signedPayload);
      if (previous) return send(200, { publication: previous });
      reserved = a;
      let match;
      try { match = await (options.lookup || freshLaunchRecipient)(draft!.handle); }
      catch { await store.fail(a); return send(503, { message: "Recipient lookup unavailable. No image or metadata was published." }); }
      if (match.address !== recipient || match.handle !== draft!.handle) { await store.fail(a); return send(409, { message: "The indexed recipient changed. Find and confirm the wallet again." }); }
      let image;
      try { image = await normalizeLaunchImage(bytes, type); }
      catch { await store.fail(a); return send(400, { message: "The image could not be fully decoded. Use a valid PNG, JPG or GIF up to 2 MB and at most 60 frames. Images are fitted automatically." }); }
      // Publication identity is independent of metadata to allow a permanent Fub
      // page URL in the metadata before any mint has been created.
      const id = hash(JSON.stringify({ version:2, owner:a.wallet, payloadHash:a.payloadHash, imageHash:image.hash }));
      const metadata = JSON.stringify({ name: draft!.name, symbol: draft!.ticker, description: draft!.description,
        image: launchAssetUrl("image", image.hash), showName: true, createdOn: FUB_CANONICAL_ORIGIN,
        ...(draft!.twitter ? { twitter: draft!.twitter } : {}), ...(draft!.telegram ? { telegram: draft!.telegram } : {}), website: `${FUB_CANONICAL_ORIGIN}/#tokens/${id}`, external_url: `${FUB_CANONICAL_ORIGIN}/#tokens/${id}` });
      const metadataHash = hash(metadata);
      const publication: PublishedLaunch = { id, owner: a.wallet, draft: draft!, recipient, imageHash: image.hash, metadataHash,
        imageUrl: launchAssetUrl("image", image.hash), metadataUrl: launchAssetUrl("metadata", metadataHash), createdAt: Date.now() };
      return send(200, { publication: await store.complete(a, publication, image.bytes, image.type, metadata) });
    } catch (error) {
      if (reserved && store) await store.fail(reserved).catch(() => {});
      if (error instanceof PublicationPending) return send(409, { message: error.message });
      return send(503, { message: "Draft storage is unavailable. Load saved drafts before publishing again." });
    } finally { pending--; }
  };
}
export const handleLaunchPublication = launchPublicationHandler();
