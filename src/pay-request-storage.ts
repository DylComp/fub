import { validPayRequest } from "./pay-model.js";
import type { PayRequest } from "./pay-model.js";
export const PAY_REQUESTS_KEY = "fomo-pay.requests.v1";
export const requestKey = (r: PayRequest) =>
  JSON.stringify([
    r.version,
    r.id,
    r.kind,
    r.recipient,
    r.cents,
    r.names,
    r.title,
    r.message,
  ]);
export function readSavedRequests(raw: string | null): PayRequest[] {
  if (!raw || raw.length > 200000) return [];
  try {
    const data = JSON.parse(raw);
    if (
      !data ||
      data.version !== 1 ||
      !Array.isArray(data.requests) ||
      data.requests.length > 30
    )
      return [];
    const seen = new Set<string>();
    return data.requests.filter((r: unknown): r is PayRequest => {
      if (!validPayRequest(r) || seen.has(requestKey(r))) return false;
      seen.add(requestKey(r));
      return true;
    });
  } catch {
    return [];
  }
}
export function loadSavedRequests(): PayRequest[] {
  try {
    return readSavedRequests(localStorage.getItem(PAY_REQUESTS_KEY));
  } catch {
    return [];
  }
}
export function saveRequest(r: PayRequest): PayRequest[] {
  if (!validPayRequest(r)) throw Error("Invalid payment request.");
  const key = requestKey(r);
  // Read at the time of the explicit action, so an idle tab does not overwrite
  // requests added in another tab. Only request details are saved, never paid flags.
  const requests = [
    r,
    ...loadSavedRequests().filter((other) => requestKey(other) !== key),
  ].slice(0, 30);
  localStorage.setItem(
    PAY_REQUESTS_KEY,
    JSON.stringify({ version: 1, requests }),
  );
  return requests;
}
export function removeSavedRequest(r: PayRequest): PayRequest[] {
  const key = requestKey(r),
    requests = loadSavedRequests().filter((other) => requestKey(other) !== key);
  localStorage.setItem(
    PAY_REQUESTS_KEY,
    JSON.stringify({ version: 1, requests }),
  );
  return requests;
}
