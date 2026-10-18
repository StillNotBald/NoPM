/**
 * Capped request-body reader shared by the public integration routes
 * (Lark /events, /card and /relay).
 *
 * Checking `Content-Length` is not enough: a chunked POST carries no length, so
 * `await request.text()` would buffer an arbitrarily large body BEFORE any
 * authentication ran, and anyone holding a public connector uuid could exhaust
 * memory on a self-host. This reads the stream chunk by chunk, counts bytes as
 * they arrive and cancels the stream the moment the cap is exceeded, so at most
 * `maxBytes` plus one chunk is ever held.
 */

export type CappedBody = { ok: true; text: string } | { ok: false; reason: "too_large" };

export async function readCappedBody(request: Request, maxBytes: number): Promise<CappedBody> {
  const stream = request.body;
  if (!stream) return { ok: true, text: "" };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling from the socket; do not wait for the sender to finish.
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder("utf-8").decode(bytes) };
}
