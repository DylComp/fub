// Public data only. Never use provider-controlled URLs or follow redirects.
export async function publicProviderJson(response: Response, limit = 524288): Promise<unknown> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit)
    throw Error('Provider response unavailable.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw Error('Provider response exceeds limit.');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
