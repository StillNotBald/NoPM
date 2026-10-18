import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { readCappedBody } from "./body";
import { handleLarkWebhook } from "./lark/http";
import { MAX_WEBHOOK_BODY_BYTES } from "./lark/verify";
import { FIXTURE_APP_URL, FIXTURE_CONNECTOR_ID, fakeHandlerDeps, fixtureConnector, fixtureSecrets } from "./lark/fixtures";

/** A chunked POST: a ReadableStream body, so there is no Content-Length header. */
function chunkedRequest(chunks: Uint8Array[], pulled?: { count: number }): Request {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) return controller.close();
      if (pulled) pulled.count += 1;
      controller.enqueue(chunks[i++]);
    },
  });
  return new Request("https://nopm.example.test/x", {
    method: "POST",
    body: stream,
    // @ts-expect-error duplex is required by Node for stream bodies
    duplex: "half",
  });
}

const enc = new TextEncoder();
const pieces = (total: number, size: number) => {
  const out: Uint8Array[] = [];
  for (let left = total; left > 0; left -= size) out.push(enc.encode("a".repeat(Math.min(size, left))));
  return out;
};

describe("readCappedBody", () => {
  it("reads a chunked body that is under the cap", async () => {
    const req = chunkedRequest(pieces(900, 100));
    expect(req.headers.get("content-length")).toBeNull();
    const res = await readCappedBody(req, 1000);
    expect(res).toEqual({ ok: true, text: "a".repeat(900) });
  });

  it("accepts a body of exactly the cap", async () => {
    const res = await readCappedBody(chunkedRequest(pieces(1000, 250)), 1000);
    expect(res.ok).toBe(true);
  });

  it("rejects a chunked body over the cap and stops reading the stream", async () => {
    const pulled = { count: 0 };
    const res = await readCappedBody(chunkedRequest(pieces(1_000_000, 100), pulled), 1000);
    expect(res).toEqual({ ok: false, reason: "too_large" });
    // Far fewer than the 10,000 chunks on offer were ever pulled (streams prefetch a little).
    expect(pulled.count).toBeLessThan(50);
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const bytes = enc.encode("héllo 世界");
    const res = await readCappedBody(chunkedRequest([bytes.slice(0, 2), bytes.slice(2, 9), bytes.slice(9)]), 1000);
    expect(res).toEqual({ ok: true, text: "héllo 世界" });
  });

  it("returns empty text for a request without a body", async () => {
    const res = await readCappedBody(new Request("https://nopm.example.test/x"), 10);
    expect(res).toEqual({ ok: true, text: "" });
  });
});

describe("handleLarkWebhook - chunked body cap", () => {
  const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
  function deps(connector: ReturnType<typeof fixtureConnector> | null) {
    const hub = fakeHandlerDeps();
    return {
      loadConnector: async () => connector,
      readSecrets: () => fixtureSecrets(),
      rateCheck: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      buildContext: (c: never, s: never) => ({ ctx: { connector: c, secrets: s, appUrl: FIXTURE_APP_URL }, deps: hub.deps }),
      now: () => NOW,
      log: () => {},
    };
  }
  function chunkedNext(chunks: Uint8Array[]) {
    const req = chunkedRequest(chunks);
    return new NextRequest(`https://nopm.example.test/api/integrations/lark/${FIXTURE_CONNECTOR_ID}/events`, {
      method: "POST",
      body: req.body,
      duplex: "half",
    });
  }

  it("413s an oversized chunked body (known connector) before authentication", async () => {
    const res = await handleLarkWebhook(
      chunkedNext(pieces(MAX_WEBHOOK_BODY_BYTES * 4, 4096)),
      FIXTURE_CONNECTOR_ID,
      deps(fixtureConnector()) as never,
    );
    expect(res.status).toBe(413);
  });

  it("413s an oversized chunked body for an unknown connector too", async () => {
    const res = await handleLarkWebhook(
      chunkedNext(pieces(MAX_WEBHOOK_BODY_BYTES * 4, 4096)),
      FIXTURE_CONNECTOR_ID,
      deps(null) as never,
    );
    expect(res.status).toBe(413);
  });

  it("an in-cap chunked body still gets the uniform 401 for an unknown connector", async () => {
    const res = await handleLarkWebhook(chunkedNext(pieces(200, 50)), FIXTURE_CONNECTOR_ID, deps(null) as never);
    expect(res.status).toBe(401);
  });
});
