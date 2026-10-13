import { isMint } from "./assets.js";
import { USDC } from "./funding-model.js";
export type PayRequest = {
  version: 1 | 2;
  id: string;
  kind: "split" | "treat";
  title: string;
  recipient: string;
  cents: number;
  names: string[];
  message: string;
};
export function payCents(text: string) {
  if (!/^(0|[1-9]\d{0,6})(\.\d{1,2})?$/.test(text))
    throw Error("Enter an amount with up to two decimal places.");
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (cents < 1 || cents > 100000000)
    throw Error("Enter an amount between 0.01 and 1,000,000 USDC.");
  return cents;
}
export const payAmount = (cents: number) =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
export function payShares(cents: number, people: number) {
  if (
    !Number.isSafeInteger(cents) ||
    cents < people ||
    cents > 100000000 ||
    !Number.isInteger(people) ||
    people < 1 ||
    people > 8
  )
    throw Error("Each person needs a share of at least 0.01 USDC.");
  return Array.from(
    { length: people },
    (_, i) => Math.floor(cents / people) + (i < cents % people ? 1 : 0),
  );
}
export function validPayRequest(data: unknown): data is PayRequest {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const d = data as PayRequest;
  return (
    Object.keys(d).sort().join(",") ===
      "cents,id,kind,message,names,recipient,title,version" &&
    [1, 2].includes(d.version) &&
    typeof d.id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      d.id,
    ) &&
    ["split", "treat"].includes(d.kind) &&
    typeof d.title === "string" &&
    d.title.trim().length > 0 &&
    d.title.length <= 80 &&
    typeof d.recipient === "string" &&
    isMint(d.recipient) &&
    Number.isSafeInteger(d.cents) &&
    d.cents > 0 &&
    d.cents <= 100000000 &&
    typeof d.message === "string" &&
    d.message.length <= 200 &&
    Array.isArray(d.names) &&
    d.names.length >= (d.kind === "split" ? 2 : 1) &&
    d.names.length <= (d.kind === "split" ? 8 : 1) &&
    d.cents >= d.names.length &&
    d.names.every(
      (n) => typeof n === "string" && n.trim().length > 0 && n.length <= 40,
    ) &&
    new Set(d.names.map((n) => n.trim().toLowerCase())).size === d.names.length
  );
}
export function payLink(request: PayRequest, origin: string) {
  if (!validPayRequest(request))
    throw Error("Check the amount, names and receiving wallet.");
  const url = new URL(origin);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw Error("Invalid share origin.");
  const bytes = new TextEncoder().encode(JSON.stringify(request));
  const encoded = btoa(
    Array.from(bytes, (b) => String.fromCharCode(b)).join(""),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${url.origin}/#pay=${encoded}`;
}
export function readPayLink(hash: string): PayRequest | null {
  if (!/^#pay=[A-Za-z0-9_-]+$/.test(hash) || hash.length > 5000) return null;
  try {
    const raw = atob(hash.slice(5).replaceAll("-", "+").replaceAll("_", "/"));
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(raw, (c) => c.charCodeAt(0)),
      ),
    );
    return validPayRequest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
export function solanaPayment(
  request: PayRequest,
  index: number,
  reference?: string,
) {
  if (
    !validPayRequest(request) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= request.names.length ||
    (request.kind === "split" && index === 0)
  )
    throw Error("Choose a friend’s share.");
  const amount = payAmount(
    payShares(request.cents, request.names.length)[index],
  );
  const query = new URLSearchParams({
    amount,
    "spl-token": USDC,
    label: "Fomo Pay",
    message: request.title,
  });
  if (request.version === 2) {
    if (!reference || !isMint(reference))
      throw Error("Payment reference is not ready.");
    query.set("reference", reference);
  }
  // No private names/message in an on-chain memo. Opening this URI requests a
  // transfer in a compatible wallet; it neither signs nor verifies a payment.
  return `solana:${request.recipient}?${query}`;
}
