export class TriggerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryAfter = 60,
  ) {
    super(message);
  }
}
export async function triggerRequest<T>(
  action: string,
  body?: unknown,
  csrf?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/trigger?action=${action}`, {
    method: action === "session" ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
    headers:
      action === "session"
        ? {}
        : {
            "Content-Type": "application/json",
            "X-Fomo-Request": "1",
            ...(csrf ? { "X-Fomo-Csrf": csrf } : {}),
          },
    ...(action !== "session" ? { body: JSON.stringify(body || {}) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new TriggerError(
      typeof data.message === "string" ? data.message : "The request failed.",
      data.code || "request_failed",
      response.status,
      Math.max(
        1,
        Math.min(300, Number(response.headers.get("Retry-After")) || 60),
      ),
    );
  return data as T;
}
