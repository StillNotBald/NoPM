/**
 * POST /api/integrations/lark/[connectorId]/relay - the self-host transport.
 *
 * The Supabase admin client and the Lark handlers are mocked, so this suite
 * asserts only what the ROUTE owns: transport authentication (HMAC over the
 * raw bytes, clock window), what an unauthenticated caller is allowed to learn,
 * connector state gating, rate limiting, request validation, and hand-off to
 * `handleLarkPayload`. The handlers' own behaviour (identity, tokens,
 * four-eyes) is tested where it lives.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  RELAY_SIGNATURE_HEADER,
  RELAY_TIMESTAMP_HEADER,
  buildRelayHeaders,
  hashRelaySecret,
  signRelayBody,
} from "@/lib/integrations/lark/relay";

const CONNECTOR_ID = "0b6f3a52-7c1e-4d2a-9a47-5f1c2b3d4e5f";
const WORKSPACE_ID = "9d2e6f10-1111-4222-8333-444455556666";
const RAW_SECRET = "npr_test-relay-secret-0123456789abcdefghij";
const SECRET_HASH = hashRelaySecret(RAW_SECRET);

// The handlers and their production wiring (identity, tokens, decisions) are tested where they live.
const handleLarkPayload = vi.fn();
const productionContext = vi.fn();
vi.mock("@/lib/integrations/lark/handlers", () => ({
  handleLarkPayload: (...a: unknown[]) => handleLarkPayload(...a),
}));
vi.mock("@/lib/integrations/lark/wiring", () => ({
  productionContext: (...a: unknown[]) => productionContext(...a),
}));
const CTX = { sentinel: "ctx" };
const DEPS = { sentinel: "deps" };

type RateReply = { data: unknown; error: { message: string } | null };
const state = {
  row: null as Record<string, unknown> | null,
  lookupError: null as { message: string } | null,
  rate: new Map<string, RateReply>(),
  rpcCalls: [] as { key: string; max: number }[],
  lookups: 0,
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async (_fn: string, args: { p_key: string; p_max: number }) => {
      state.rpcCalls.push({ key: args.p_key, max: args.p_max });
      const prefix = [...state.rate.keys()].find((k) => args.p_key.startsWith(k));
      return prefix ? state.rate.get(prefix)! : { data: { allowed: true, remaining: 99, retry_after_seconds: 0 }, error: null };
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => {
              state.lookups++;
              return { data: state.row, error: state.lookupError };
            },
          }),
        }),
      }),
    }),
  }),
}));

let POST: (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function connectorRow(over: Record<string, unknown> = {}) {
  return {
    id: CONNECTOR_ID,
    workspace_id: WORKSPACE_ID,
    kind: "lark",
    name: "Lark",
    status: "active",
    config: { region: "lark", appId: "cli_a1b2c3d4e5f6a7b8", mode: "long_connection", approvals: { enabled: true }, digest: { enabled: false, chatId: null, weekday: 1 } },
    secret_enc: "enc:opaque",
    relay_secret_hash: SECRET_HASH,
    created_by: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    revoked_at: null,
    ...over,
  };
}

const messageEnvelope = {
  schema: "2.0",
  header: { event_id: "ev_msg_1", event_type: "im.message.receive_v1", tenant_key: "tk_1", app_id: "cli_a1b2c3d4e5f6a7b8" },
  event: { sender: { sender_id: { open_id: "ou_abc" } }, message: { chat_type: "p2p", message_type: "text", content: '{"text":"help"}' } },
};
const cardEnvelope = {
  schema: "2.0",
  header: { event_id: "ev_card_1", event_type: "card.action.trigger", tenant_key: "tk_1", app_id: "cli_a1b2c3d4e5f6a7b8" },
  event: { operator: { open_id: "ou_abc", tenant_key: "tk_1" }, token: "c-1", action: { value: { t: "tok", a: "approve" }, tag: "button" } },
};

/** A correctly signed relay request unless told otherwise. */
function relayRequest(
  body: unknown,
  opts: { headers?: Record<string, string | null>; raw?: string; forwardedFor?: string | null; secret?: string; nowMs?: number } = {},
): NextRequest {
  const raw = opts.raw ?? (typeof body === "string" ? body : JSON.stringify(body));
  const signed = buildRelayHeaders(opts.secret ?? RAW_SECRET, raw, opts.nowMs ?? Date.now());
  const headers: Record<string, string> = { "content-type": "application/json", ...signed };
  if (opts.forwardedFor !== null) headers["x-forwarded-for"] = opts.forwardedFor ?? "203.0.113.7";
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (v === null) delete headers[k];
    else headers[k] = v;
  }
  return new NextRequest(`http://localhost/api/integrations/lark/${CONNECTOR_ID}/relay`, { method: "POST", headers, body: raw });
}

const call = (req: NextRequest, connectorId = CONNECTOR_ID) => POST(req, { params: Promise.resolve({ connectorId }) });
const limited = { data: { allowed: false, remaining: 0, retry_after_seconds: 12 }, error: null };

beforeEach(async () => {
  vi.clearAllMocks();
  state.row = connectorRow();
  state.lookupError = null;
  state.rate = new Map();
  state.rpcCalls = [];
  state.lookups = 0;
  handleLarkPayload.mockResolvedValue({ status: 200, body: {} });
  productionContext.mockReset();
  productionContext.mockReturnValue({ ctx: CTX, deps: DEPS });
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  ({ POST } = (await import("./route")) as unknown as { POST: typeof POST });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("relay route — lookup and shape checks", () => {
  it("404s a malformed connector id without touching the database", async () => {
    const res = await call(relayRequest({ type: "ping" }), "not-a-uuid");
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("connector_not_found");
    expect(state.lookups).toBe(0);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("answers an unknown connector with the same 401 a wrong signature gets", async () => {
    state.row = null;
    const res = await call(relayRequest({ type: "ping" }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("invalid_relay_signature");
    expect(handleLarkPayload).not.toHaveBeenCalled();
  });

  it("sanitises a database failure into a 500", async () => {
    state.lookupError = { message: "relation integration_connectors does not exist" };
    const res = await call(relayRequest({ type: "ping" }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("integration_connectors");
  });

  it("413s a body that declares itself too large, before reading it", async () => {
    const res = await call(relayRequest({ type: "ping" }, { headers: { "content-length": String(300 * 1024) } }));
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("body_too_large");
    expect(state.lookups).toBe(0);
  });

  it("413s a body that is too large in fact", async () => {
    const big = JSON.stringify({ type: "ping", pad: "x".repeat(260 * 1024) });
    const res = await call(relayRequest(big));
    expect(res.status).toBe(413);
  });

  function chunkedRelay(totalBytes: number, chunk = 4096): NextRequest {
    const enc = new TextEncoder();
    let left = totalBytes;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (left <= 0) return c.close();
        const n = Math.min(chunk, left);
        left -= n;
        c.enqueue(enc.encode("x".repeat(n)));
      },
    });
    return new NextRequest(`http://localhost/api/integrations/lark/${CONNECTOR_ID}/relay`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: stream,
      duplex: "half",
    });
  }

  it("413s a chunked body (no Content-Length) that exceeds the cap, without buffering it", async () => {
    const req = chunkedRelay(5 * 1024 * 1024);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await call(req);
    expect(res.status).toBe(413);
    expect((await res.json()).code).toBe("body_too_large");
  });

  it("a small chunked body is read and reaches signature verification (401, not 413)", async () => {
    const res = await call(chunkedRelay(100));
    expect(res.status).toBe(401);
  });
});

describe("relay route — transport authentication", () => {
  it("accepts a correctly signed ping", async () => {
    const res = await call(relayRequest({ type: "ping" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { ok: true, connector_id: CONNECTOR_ID, mode: "long_connection", status: "active" },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(handleLarkPayload).not.toHaveBeenCalled();
  });

  it("401s a signature made with the wrong secret", async () => {
    const res = await call(relayRequest({ type: "ping" }, { secret: "npr_some-other-secret-entirely-xxxxxxxx" }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("invalid_relay_signature");
  });

  it("401s when the body was changed after signing", async () => {
    const signed = buildRelayHeaders(RAW_SECRET, JSON.stringify({ type: "ping" }));
    const req = relayRequest({ type: "event", payload: messageEnvelope }, { headers: { ...signed } });
    const res = await call(req);
    expect(res.status).toBe(401);
    expect(handleLarkPayload).not.toHaveBeenCalled();
  });

  it("401s a re-serialised body (the signature covers the exact bytes)", async () => {
    const compact = JSON.stringify({ type: "ping" });
    const signed = buildRelayHeaders(RAW_SECRET, compact);
    const req = relayRequest(null, { raw: '{ "type": "ping" }', headers: { ...signed } });
    expect((await call(req)).status).toBe(401);
  });

  it("401s a stale timestamp with a clock hint", async () => {
    const res = await call(relayRequest({ type: "ping" }, { nowMs: Date.now() - 10 * 60 * 1000 }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("stale_relay_timestamp");
    expect(body.error).toMatch(/clock/);
  });

  it("accepts a timestamp inside the window (4 minutes old)", async () => {
    const res = await call(relayRequest({ type: "ping" }, { nowMs: Date.now() - 4 * 60 * 1000 }));
    expect(res.status).toBe(200);
  });

  it.each([
    ["timestamp", RELAY_TIMESTAMP_HEADER],
    ["signature", RELAY_SIGNATURE_HEADER],
  ])("401s a request with no %s header", async (_n, header) => {
    const res = await call(relayRequest({ type: "ping" }, { headers: { [header]: null } }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("invalid_relay_signature");
  });

  it("fails closed when the connector has no relay secret (webhook-mode connector)", async () => {
    state.row = connectorRow({ relay_secret_hash: null, config: { region: "lark", appId: "cli_x", mode: "webhook" } });
    const res = await call(relayRequest({ type: "ping" }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("no_relay_secret");
  });

  it("fails closed on a malformed stored hash", async () => {
    state.row = connectorRow({ relay_secret_hash: "not-a-hash" });
    expect((await call(relayRequest({ type: "ping" }))).status).toBe(401);
  });

  it("logs only the connector id and the reason for a rejected request", async () => {
    const warn = vi.mocked(console.warn);
    await call(relayRequest({ type: "event", payload: messageEnvelope }, { secret: "npr_wrong-secret-wrong-secret-wrong" }));
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain(CONNECTOR_ID);
    expect(logged).toContain("bad_signature");
    expect(logged).not.toContain("ou_abc");
    expect(logged).not.toContain("npr_wrong");
    expect(logged).not.toMatch(/v1=[0-9a-f]{64}/);
  });
});

describe("relay route — an unauthenticated caller learns nothing about connector state", () => {
  it.each([
    ["paused", { status: "paused" }],
    ["revoked", { status: "revoked" }],
    ["webhook mode", { config: { region: "lark", appId: "cli_x", mode: "webhook" } }],
  ])("a %s connector with a bad signature is a plain 401, not a 403", async (_n, over) => {
    state.row = connectorRow(over);
    const res = await call(relayRequest({ type: "ping" }, { secret: "npr_wrong-secret-wrong-secret-wrong" }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("invalid_relay_signature");
  });
});

describe("relay route — connector state (after authentication)", () => {
  it.each(["paused", "revoked"])("403s a %s connector", async (status) => {
    state.row = connectorRow({ status });
    const res = await call(relayRequest({ type: "event", payload: messageEnvelope }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("connector_inactive");
    expect(handleLarkPayload).not.toHaveBeenCalled();
  });

  it("403s a connector that is in webhook mode", async () => {
    state.row = connectorRow({ config: { region: "lark", appId: "cli_x", mode: "webhook" } });
    const res = await call(relayRequest({ type: "card", payload: cardEnvelope }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("wrong_mode");
    expect(handleLarkPayload).not.toHaveBeenCalled();
  });

  it("treats a connector whose config has no mode as webhook (normalised), so 403", async () => {
    state.row = connectorRow({ config: {} });
    const res = await call(relayRequest({ type: "ping" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("wrong_mode");
  });

  it("rejects a ping from a paused connector too (the worker's boot check must fail loudly)", async () => {
    state.row = connectorRow({ status: "paused" });
    expect((await call(relayRequest({ type: "ping" }))).status).toBe(403);
  });
});

describe("relay route — rate limiting", () => {
  // One reverse proxy in front: the client address is the rightmost x-forwarded-for entry
  // (see @/lib/api/client-ip — nothing is trusted unless an operator says so).
  beforeEach(() => {
    vi.stubEnv("NOPM_TRUSTED_PROXY_HOPS", "1");
  });

  it("applies an IP-keyed cap before authentication and a connector-keyed cap after", async () => {
    await call(relayRequest({ type: "ping" }));
    expect(state.rpcCalls.map((c) => c.key)).toEqual([`lark-relay-ip:203.0.113.7`, `lark-relay:${CONNECTOR_ID}`]);
  });

  it("429s when the IP cap is exhausted, before any handler runs", async () => {
    state.rate.set("lark-relay-ip:", limited);
    const res = await call(relayRequest({ type: "event", payload: messageEnvelope }));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("rate_limited");
    expect(handleLarkPayload).not.toHaveBeenCalled();
  });

  it("charges the connector cap only to an authenticated caller", async () => {
    state.rate.set("lark-relay:", limited);
    const bad = await call(relayRequest({ type: "ping" }, { secret: "npr_wrong-secret-wrong-secret-wrong" }));
    expect(bad.status).toBe(401); // a stranger cannot burn or even observe this connector's budget
    expect(state.rpcCalls.map((c) => c.key)).toEqual([`lark-relay-ip:203.0.113.7`]);
    const good = await call(relayRequest({ type: "ping" }));
    expect(good.status).toBe(429);
  });

  it("answers a rate-limited CARD click with a 200 toast (words, not an error code), like the webhook routes", async () => {
    state.rate.set("lark-relay:", limited);
    const res = await call(relayRequest({ type: "card", payload: cardEnvelope }));
    expect(res.status).toBe(200);
    expect((await res.json()).toast).toMatchObject({ type: "warning" });
    expect(handleLarkPayload).not.toHaveBeenCalled();
  });

  it("429s a rate-limited event so the worker retries it", async () => {
    state.rate.set("lark-relay:", limited);
    const res = await call(relayRequest({ type: "event", payload: messageEnvelope }));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("rate_limited");
    expect(handleLarkPayload).not.toHaveBeenCalled();
  });

  it("skips the IP cap when no client IP is available (no shared bucket a stranger could exhaust)", async () => {
    await call(relayRequest({ type: "ping" }, { forwardedFor: null }));
    expect(state.rpcCalls.map((c) => c.key)).toEqual([`lark-relay:${CONNECTOR_ID}`]);
  });

  it("keys on the address the trusted proxy appended (rightmost), never the client-written first entry", async () => {
    await call(relayRequest({ type: "ping" }, { forwardedFor: "10.9.9.9, 198.51.100.9" }));
    expect(state.rpcCalls[0].key).toBe("lark-relay-ip:198.51.100.9");
  });

  it("rotating a spoofed first x-forwarded-for entry does not buy a fresh IP bucket (R1 E1.4)", async () => {
    for (const spoof of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
      state.rpcCalls = [];
      await call(relayRequest({ type: "ping" }, { forwardedFor: `${spoof}, 198.51.100.9` }));
      expect(state.rpcCalls[0].key).toBe("lark-relay-ip:198.51.100.9");
    }
  });

  it("with no trusted proxy configured, x-forwarded-for is ignored and the IP cap is skipped", async () => {
    vi.unstubAllEnvs();
    await call(relayRequest({ type: "ping" }, { forwardedFor: "198.51.100.9" }));
    expect(state.rpcCalls.map((c) => c.key)).toEqual([`lark-relay:${CONNECTOR_ID}`]);
  });

  it("fails open, loudly, when the rate-limit RPC itself errors", async () => {
    state.rate.set("lark-relay", { data: null, error: { message: "rpc down" } });
    const res = await call(relayRequest({ type: "ping" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(console.error)).toHaveBeenCalled();
  });
});

describe("relay route — request validation (authenticated, signed bodies)", () => {
  it("422s a signed body that is not JSON", async () => {
    const res = await call(relayRequest("not json at all"));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("invalid_relay_request");
  });

  it.each([
    ["unknown type", { type: "broadcast" }],
    ["event without payload", { type: "event" }],
    ["payload without event_id", { type: "event", payload: { header: { event_type: "im.message.receive_v1" }, event: {} } }],
    ["array body", []],
  ])("422s %s", async (_n, body) => {
    const res = await call(relayRequest(body));
    expect(res.status).toBe(422);
    expect(handleLarkPayload).not.toHaveBeenCalled();
  });

  it("422s a type that disagrees with the event type", async () => {
    const asCard = await call(relayRequest({ type: "card", payload: messageEnvelope }));
    const asEvent = await call(relayRequest({ type: "event", payload: cardEnvelope }));
    expect(asCard.status).toBe(422);
    expect(asEvent.status).toBe(422);
    expect((await asCard.json()).code).toBe("invalid_relay_request");
    expect(handleLarkPayload).not.toHaveBeenCalled();
  });
});

describe("relay route — hand-off to the handlers", () => {
  it("passes the loaded connector's context, the envelope and the deps to handleLarkPayload for an event", async () => {
    const res = await call(relayRequest({ type: "event", payload: messageEnvelope }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(res.headers.get("cache-control")).toBe("no-store");

    const [connectorForCtx] = productionContext.mock.calls[0];
    expect(connectorForCtx).toMatchObject({ id: CONNECTOR_ID, workspace_id: WORKSPACE_ID, relay_secret_hash: SECRET_HASH });
    expect(connectorForCtx.config.mode).toBe("long_connection");

    expect(handleLarkPayload).toHaveBeenCalledTimes(1);
    const [ctx, envelope, deps] = handleLarkPayload.mock.calls[0];
    expect(ctx).toBe(CTX);
    expect(deps).toBe(DEPS);
    expect(envelope).toEqual(messageEnvelope);
  });

  it("returns a card click's JSON verbatim (not wrapped in { data })", async () => {
    const reply = { toast: { type: "success", content: "Approved" }, card: { type: "raw", data: { schema: "2.0" } } };
    handleLarkPayload.mockResolvedValue({ status: 200, body: reply });
    const res = await call(relayRequest({ type: "card", payload: cardEnvelope }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(reply);
    expect(handleLarkPayload.mock.calls[0][1]).toEqual(cardEnvelope);
  });

  it("relays a non-200 status from the handlers unchanged", async () => {
    handleLarkPayload.mockResolvedValue({ status: 202, body: { accepted: true } });
    const res = await call(relayRequest({ type: "event", payload: messageEnvelope }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true });
  });

  it("answers {} when a handler has nothing to send back", async () => {
    handleLarkPayload.mockResolvedValue({ status: 200, body: undefined });
    expect(await (await call(relayRequest({ type: "event", payload: messageEnvelope }))).json()).toEqual({});
    handleLarkPayload.mockResolvedValue({ status: 200, body: null });
    expect(await (await call(relayRequest({ type: "event", payload: messageEnvelope }))).json()).toEqual({});
  });

  it("keeps unknown envelope fields intact for the handler", async () => {
    const withExtras = { ...messageEnvelope, header: { ...messageEnvelope.header, create_time: "1760000000000", future_field: 1 } };
    await call(relayRequest({ type: "event", payload: withExtras }));
    expect(handleLarkPayload.mock.calls[0][1].header).toMatchObject({ create_time: "1760000000000", future_field: 1 });
  });

  it("does not build a handler context (no secret decryption) for a ping", async () => {
    await call(relayRequest({ type: "ping" }));
    expect(productionContext).not.toHaveBeenCalled();
  });

  it("503s with a stable code, and no detail, when the connector's secrets cannot be decrypted", async () => {
    productionContext.mockImplementation(() => {
      throw new Error("NOPM_ENCRYPTION_KEY is not set");
    });
    const res = await call(relayRequest({ type: "event", payload: messageEnvelope }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("connector_unavailable");
    expect(JSON.stringify(body)).not.toContain("NOPM_ENCRYPTION_KEY");
    expect(handleLarkPayload).not.toHaveBeenCalled();
  });

  it("turns an unexpected handler crash into a sanitised 500 in production (the worker will retry the event)", async () => {
    vi.stubEnv("NODE_ENV", "production"); // toErrorResponse only withholds messages in production
    handleLarkPayload.mockRejectedValue(new Error("password=hunter2 leaked in a stack trace"));
    const res = await call(relayRequest({ type: "event", payload: messageEnvelope }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("hunter2");
  });

  it("the HMAC key is the stored hash itself, not the raw secret and not a hash of the hash", async () => {
    // Treating the stored hash as if it were the raw secret derives sha256(hash): a different key.
    const res = await call(relayRequest({ type: "ping" }, { secret: SECRET_HASH }));
    expect(res.status).toBe(401);
    // Signing directly with the stored hash as the HMAC key (what the worker computes) succeeds.
    const raw = JSON.stringify({ type: "ping" });
    const ts = String(Math.floor(Date.now() / 1000));
    const req = relayRequest(null, {
      raw,
      headers: { [RELAY_TIMESTAMP_HEADER]: ts, [RELAY_SIGNATURE_HEADER]: signRelayBody(SECRET_HASH, ts, raw) },
    });
    expect((await call(req)).status).toBe(200);
  });
});

describe("relay route — pre-authentication answers and keys", () => {
  beforeEach(() => {
    vi.stubEnv("NOPM_TRUSTED_PROXY_HOPS", "1");
  });

  it("answers an unknown connector byte-for-byte like a wrong signature on a real one", async () => {
    const wrong = await call(relayRequest({ type: "ping" }, { secret: "npr_wrong-secret-wrong-secret-wrong" }));
    const wrongBody = JSON.stringify(await wrong.json());
    state.row = null;
    const unknown = await call(relayRequest({ type: "ping" }));
    expect(unknown.status).toBe(wrong.status);
    expect(JSON.stringify(await unknown.json())).toBe(wrongBody);
  });

  it("an unknown connector is not even a distinguishable timing/DB path: it still runs the signature check against a decoy", async () => {
    state.row = null;
    const res = await call(relayRequest({ type: "ping" }, { secret: "npr_wrong-secret-wrong-secret-wrong" }));
    expect(res.status).toBe(401);
    expect(handleLarkPayload).not.toHaveBeenCalled();
  });

  it("keys IPv6 callers on their /64, so rotating the low bits buys no new bucket or counter row", async () => {
    for (const addr of ["2001:db8:0:1::1", "2001:db8:0:1:ffff:ffff:ffff:ffff", "2001:DB8:0:1::abcd"]) {
      state.rpcCalls = [];
      await call(relayRequest({ type: "ping" }, { forwardedFor: addr }));
      expect(state.rpcCalls[0].key).toBe("lark-relay-ip:2001:db8:0:1::/64");
    }
  });

  it("ignores a header value that is not an address at all (no counter row keyed by junk)", async () => {
    await call(relayRequest({ type: "ping" }, { forwardedFor: "not-an-ip'; select 1" }));
    expect(state.rpcCalls.map((c) => c.key)).toEqual([`lark-relay:${CONNECTOR_ID}`]);
  });
});
