/**
 * Relay protocol (2026-10-16): the signing contract between the self-host
 * worker (web/scripts/lark-worker.mjs) and the relay route.
 *
 * Three layers:
 *   1. verify/sign semantics against independently computed vectors (Python's
 *      hmac/hashlib, not this module) so a refactor cannot silently change the
 *      wire format;
 *   2. the request-body schema the route validates;
 *   3. parity with the worker script - it duplicates the signing code so it
 *      can be copied onto any box on its own, so THIS file is what proves the
 *      two copies stay byte-identical, and that the worker's SDK-flattened
 *      events rebuild into the exact envelope the hosted webhook receives
 *      (checked against the real SDK EventDispatcher, offline).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as Lark from "@larksuiteoapi/node-sdk";

// Wrap, not replace: lets one test assert the comparison is constant-time
// without changing behaviour for the rest.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

import * as nodeCrypto from "node:crypto";
import {
  CARD_ACTION_EVENT_TYPE,
  RELAY_MAX_BODY_BYTES,
  RELAY_SIGNATURE_HEADER,
  RELAY_TIMESTAMP_HEADER,
  RELAY_TOLERANCE_SECONDS,
  buildRelayHeaders,
  hashRelaySecret,
  relayRequestSchema,
  relayTypeMatchesEvent,
  signRelayBody,
  verifyRelaySignature,
} from "./relay";

const RAW_SECRET = "nopm-relay-test-secret-0123456789abcdef";
const SECRET_HASH = "df7827aa1c2c2afcbae0dbce738daf0c250e816844d119c02f3a03286152c029";
const TS = "1760000000";
const NOW_MS = 1_760_000_000_000;
const PING_BODY = '{"type":"ping"}';
const PING_SIG = "v1=4623421c8f8e467875a36dcac519aa14f0add20031dbf2547021b1f460f95e20";
const UNICODE_BODY =
  '{"type":"event","payload":{"header":{"event_id":"ev_1","event_type":"im.message.receive_v1"},"event":{"text":"héllo 你好"}}}';
const UNICODE_SIG = "v1=920fffdfd351a1d15baa9e8f960c30fe21669c27c22f6dd0373c9fa5943eeac8";

function verify(over: Partial<Parameters<typeof verifyRelaySignature>[0]> = {}) {
  return verifyRelaySignature({
    secretHash: SECRET_HASH,
    timestamp: TS,
    signature: PING_SIG,
    rawBody: PING_BODY,
    nowMs: NOW_MS,
    ...over,
  });
}

describe("hashRelaySecret", () => {
  it("is lowercase hex SHA-256 (published vector for 'abc')", () => {
    expect(hashRelaySecret("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("matches the independently computed hash of the test secret", () => {
    expect(hashRelaySecret(RAW_SECRET)).toBe(SECRET_HASH);
  });
});

describe("signRelayBody — wire format", () => {
  it("matches an independently computed HMAC-SHA256(sha256hex(secret), ts + '.' + body)", () => {
    expect(signRelayBody(SECRET_HASH, TS, PING_BODY)).toBe(PING_SIG);
  });

  it("signs the UTF-8 bytes of a non-ASCII body", () => {
    expect(signRelayBody(SECRET_HASH, TS, UNICODE_BODY)).toBe(UNICODE_SIG);
  });

  it("buildRelayHeaders derives the key from the RAW secret and stamps unix seconds", () => {
    const h = buildRelayHeaders(RAW_SECRET, PING_BODY, NOW_MS + 999);
    expect(h[RELAY_TIMESTAMP_HEADER]).toBe(TS);
    expect(h[RELAY_SIGNATURE_HEADER]).toBe(PING_SIG);
  });

  it("uses lowercase header names (the route reads them case-insensitively via Headers)", () => {
    expect(RELAY_TIMESTAMP_HEADER).toBe("x-nopm-relay-timestamp");
    expect(RELAY_SIGNATURE_HEADER).toBe("x-nopm-relay-signature");
  });
});

describe("verifyRelaySignature", () => {
  it("accepts a correctly signed request", () => {
    expect(verify()).toEqual({ ok: true });
  });

  it("round-trips whatever buildRelayHeaders produced", () => {
    const body = JSON.stringify({ type: "event", payload: { header: {}, event: { a: "b" } } });
    const h = buildRelayHeaders(RAW_SECRET, body, NOW_MS);
    expect(
      verify({ rawBody: body, timestamp: h[RELAY_TIMESTAMP_HEADER], signature: h[RELAY_SIGNATURE_HEADER] }),
    ).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    expect(verify({ rawBody: '{"type":"pong"}' })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a re-serialised body (whitespace changes the signed bytes)", () => {
    expect(verify({ rawBody: '{"type": "ping"}' })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature made with a different secret", () => {
    const other = signRelayBody(hashRelaySecret("a-different-secret-entirely-1234"), TS, PING_BODY);
    expect(verify({ signature: other })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature bound to a different timestamp", () => {
    expect(verify({ timestamp: "1760000001" })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("does NOT accept the raw secret as the HMAC key (the stored hash is the key)", () => {
    const withRaw = `v1=${nodeCrypto.createHmac("sha256", RAW_SECRET).update(`${TS}.${PING_BODY}`).digest("hex")}`;
    expect(verify({ signature: withRaw })).toEqual({ ok: false, reason: "bad_signature" });
  });

  describe("clock window", () => {
    const at = (offsetSeconds: number) => ({
      timestamp: String(1_760_000_000 + offsetSeconds),
    });
    const signedAt = (offsetSeconds: number) => {
      const timestamp = String(1_760_000_000 + offsetSeconds);
      return { timestamp, signature: signRelayBody(SECRET_HASH, timestamp, PING_BODY) };
    };

    it("accepts exactly +/- the tolerance", () => {
      expect(verify(signedAt(RELAY_TOLERANCE_SECONDS))).toEqual({ ok: true });
      expect(verify(signedAt(-RELAY_TOLERANCE_SECONDS))).toEqual({ ok: true });
    });

    it("rejects one second beyond the tolerance, in both directions", () => {
      expect(verify(signedAt(RELAY_TOLERANCE_SECONDS + 1))).toEqual({ ok: false, reason: "stale" });
      expect(verify(signedAt(-RELAY_TOLERANCE_SECONDS - 1))).toEqual({ ok: false, reason: "stale" });
    });

    it("reports stale before signature (so operators learn about clock skew)", () => {
      expect(verify({ ...at(10_000) })).toEqual({ ok: false, reason: "stale" });
    });

    it("is 5 minutes", () => {
      expect(RELAY_TOLERANCE_SECONDS).toBe(300);
    });
  });

  describe("malformed input", () => {
    it.each([
      ["no timestamp", { timestamp: null }],
      ["empty timestamp", { timestamp: "" }],
      ["no signature", { signature: null }],
      ["empty signature", { signature: "" }],
    ])("%s -> missing_headers", (_name, over) => {
      expect(verify(over)).toEqual({ ok: false, reason: "missing_headers" });
    });

    it.each([
      ["letters", "abc"],
      ["decimal", "1760000000.5"],
      ["negative", "-1760000000"],
      ["exponent", "1e9"],
      ["leading space", " 1760000000"],
      ["13 digits (milliseconds)", "1760000000000"],
    ])("timestamp %s -> bad_timestamp", (_name, timestamp) => {
      expect(verify({ timestamp })).toEqual({ ok: false, reason: "bad_timestamp" });
    });

    it.each([
      ["no version prefix", PING_SIG.slice(3)],
      ["wrong version", PING_SIG.replace("v1=", "v2=")],
      ["uppercase hex", PING_SIG.toUpperCase().replace("V1=", "v1=")],
      ["truncated", PING_SIG.slice(0, -2)],
      ["too long", `${PING_SIG}00`],
      ["non-hex", `v1=${"z".repeat(64)}`],
      ["two signatures", `${PING_SIG}, ${PING_SIG}`],
    ])("signature %s -> bad_signature", (_name, signature) => {
      expect(verify({ signature })).toEqual({ ok: false, reason: "bad_signature" });
    });
  });

  describe("stored secret hash (fail closed)", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["empty", ""],
      ["too short", "abc123"],
      ["not hex", "z".repeat(64)],
      ["uppercase", SECRET_HASH.toUpperCase()],
    ])("%s -> no_secret, even with an otherwise valid request", (_name, secretHash) => {
      expect(verify({ secretHash })).toEqual({ ok: false, reason: "no_secret" });
    });
  });

  it("compares with timingSafeEqual", () => {
    const spy = vi.mocked(nodeCrypto.timingSafeEqual);
    spy.mockClear();
    verify();
    expect(spy).toHaveBeenCalledTimes(1);
    const [a, b] = spy.mock.calls[0];
    expect(Buffer.from(a as Uint8Array)).toHaveLength(32);
    expect(Buffer.from(b as Uint8Array)).toHaveLength(32);
  });

  it("does not reach the comparison for a malformed signature (no length oracle needed)", () => {
    const spy = vi.mocked(nodeCrypto.timingSafeEqual);
    spy.mockClear();
    verify({ signature: "v1=abcd" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("relayRequestSchema", () => {
  const message = {
    schema: "2.0",
    header: { event_id: "ev_1", event_type: "im.message.receive_v1", tenant_key: "tk_1", app_id: "cli_a1b2c3d4e5f6a7b8" },
    event: { sender: {}, message: {} },
  };
  const card = { ...message, header: { ...message.header, event_type: CARD_ACTION_EVENT_TYPE } };

  it("accepts ping without a payload", () => {
    expect(relayRequestSchema.safeParse({ type: "ping" }).success).toBe(true);
  });

  it("accepts event and card envelopes and keeps unknown header fields", () => {
    const e = relayRequestSchema.safeParse({ type: "event", payload: message });
    const c = relayRequestSchema.safeParse({ type: "card", payload: card });
    expect(e.success && c.success).toBe(true);
    if (e.success && e.data.type === "event") {
      expect(e.data.payload.header).toMatchObject({ tenant_key: "tk_1", app_id: "cli_a1b2c3d4e5f6a7b8" });
    }
  });

  it.each([
    ["unknown type", { type: "broadcast", payload: message }],
    ["no payload on event", { type: "event" }],
    ["missing header", { type: "event", payload: { event: {} } }],
    ["missing event_id", { type: "event", payload: { header: { event_type: "x" }, event: {} } }],
    ["empty event_type", { type: "event", payload: { header: { event_id: "e", event_type: "" }, event: {} } }],
    ["event is not an object", { type: "event", payload: { header: { event_id: "e", event_type: "x" }, event: "boom" } }],
    ["array body", []],
    ["null body", null],
  ])("rejects %s", (_name, body) => {
    expect(relayRequestSchema.safeParse(body).success).toBe(false);
  });

  it("requires type and header.event_type to agree", () => {
    const e = relayRequestSchema.parse({ type: "event", payload: message });
    const c = relayRequestSchema.parse({ type: "card", payload: card });
    const eAsCard = relayRequestSchema.parse({ type: "card", payload: message });
    const cAsEvent = relayRequestSchema.parse({ type: "event", payload: card });
    if (e.type === "ping" || c.type === "ping" || eAsCard.type === "ping" || cAsEvent.type === "ping") throw new Error("narrow");
    expect(relayTypeMatchesEvent(e)).toBe(true);
    expect(relayTypeMatchesEvent(c)).toBe(true);
    expect(relayTypeMatchesEvent(eAsCard)).toBe(false);
    expect(relayTypeMatchesEvent(cAsEvent)).toBe(false);
  });

  it("caps the body well above any real Lark event", () => {
    expect(RELAY_MAX_BODY_BYTES).toBe(256 * 1024);
  });
});

// ---------------------------------------------------------------------------
// Parity with web/scripts/lark-worker.mjs
// ---------------------------------------------------------------------------
type WorkerModule = {
  hashRelaySecret: (s: string) => string;
  signRelayBody: (h: string, t: string, b: string) => string;
  buildRelayHeaders: (s: string, b: string, now?: number) => Record<string, string>;
  toEnvelope: (flat: Record<string, unknown>) => { schema: string; header: Record<string, unknown>; event: Record<string, unknown> };
  relay: (
    cfg: Record<string, unknown>,
    type: string,
    payload: unknown,
    deps: { fetch: typeof fetch; now?: () => number },
  ) => Promise<{ status: number; json: Record<string, unknown> }>;
};

let worker: WorkerModule;

beforeAll(async () => {
  process.env.NOPM_LARK_WORKER_IMPORT_ONLY = "1"; // importing must not open a socket
  // Variable specifier on purpose: it is a plain .mjs with no type declarations.
  const href = pathToFileURL(resolve(__dirname, "../../../../scripts/lark-worker.mjs")).href;
  worker = (await import(/* @vite-ignore */ href)) as WorkerModule;
});

describe("worker <-> server signing parity", () => {
  it.each([
    ["ping", PING_BODY],
    ["non-ASCII event", UNICODE_BODY],
    ["empty object", "{}"],
    ["large body", JSON.stringify({ pad: "x".repeat(50_000) })],
  ])("worker and server agree byte-for-byte: %s", (_name, body) => {
    expect(worker.hashRelaySecret(RAW_SECRET)).toBe(hashRelaySecret(RAW_SECRET));
    expect(worker.signRelayBody(SECRET_HASH, TS, body)).toBe(signRelayBody(SECRET_HASH, TS, body));
    expect(worker.buildRelayHeaders(RAW_SECRET, body, NOW_MS)).toEqual(buildRelayHeaders(RAW_SECRET, body, NOW_MS));
  });

  it("a request the worker actually sends verifies on the server side", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;

    const envelope = {
      schema: "2.0",
      header: { event_id: "ev_1", event_type: "im.message.receive_v1" },
      event: { note: "héllo 你好" },
    };
    await worker.relay(
      { relayUrl: "http://127.0.0.1:3000/api/integrations/lark/x/relay", relaySecret: RAW_SECRET, timeoutMs: 2500 },
      "event",
      envelope,
      { fetch: fakeFetch, now: () => NOW_MS },
    );

    const headers = seen!.init.headers as Record<string, string>;
    expect(
      verifyRelaySignature({
        secretHash: SECRET_HASH,
        timestamp: headers[RELAY_TIMESTAMP_HEADER],
        signature: headers[RELAY_SIGNATURE_HEADER],
        rawBody: seen!.init.body as string,
        nowMs: NOW_MS,
      }),
    ).toEqual({ ok: true });
    // The same bytes also satisfy the request schema the route applies.
    expect(relayRequestSchema.safeParse(JSON.parse(seen!.init.body as string)).success).toBe(true);
  });
});

describe("worker toEnvelope vs the real SDK EventDispatcher", () => {
  const messageRaw = {
    schema: "2.0",
    header: {
      event_id: "ev_msg_1",
      token: "app-verification-token",
      create_time: "1760000000000",
      event_type: "im.message.receive_v1",
      tenant_key: "tk_1",
      app_id: "cli_a1b2c3d4e5f6a7b8",
    },
    event: {
      sender: { sender_id: { open_id: "ou_abc", union_id: "on_abc", user_id: "u1" }, sender_type: "user", tenant_key: "tk_1" },
      message: {
        message_id: "om_2",
        chat_id: "oc_2",
        chat_type: "p2p",
        message_type: "text",
        content: '{"text":"help"}',
        create_time: "1760000000000",
      },
    },
  };
  const cardRaw = {
    schema: "2.0",
    header: {
      event_id: "ev_card_1",
      token: "app-verification-token",
      create_time: "1760000000000",
      event_type: "card.action.trigger",
      tenant_key: "tk_1",
      app_id: "cli_a1b2c3d4e5f6a7b8",
    },
    event: {
      operator: { tenant_key: "tk_1", user_id: "u1", open_id: "ou_abc", union_id: "on_abc" },
      token: "c-0123456789abcdef",
      action: {
        value: { t: "action-token", a: "reject" },
        tag: "button",
        timezone: "Asia/Kuala_Lumpur",
        form_value: { reason: "needs a rollback plan" },
      },
      host: "im_message",
      delivery_type: "url",
      context: { url: "", preview_token: "", open_message_id: "om_1", open_chat_id: "oc_1" },
    },
  };

  /** The header the worker forwards: everything except the app's verification token. */
  const withoutToken = (header: Record<string, unknown>) => Object.fromEntries(Object.entries(header).filter(([k]) => k !== "token"));

  /** Run a raw envelope through the SDK's own parse + dispatch, capture what a handler receives. */
  async function throughSdk(raw: unknown, eventType: string): Promise<Record<string, unknown>> {
    let received: Record<string, unknown> | undefined;
    const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.error }).register({
      [eventType]: async (data: Record<string, unknown>) => {
        received = data;
      },
    } as never);
    await dispatcher.invoke(raw, { needCheck: false });
    if (!received) throw new Error("SDK did not dispatch the event");
    return received;
  }

  it("rebuilds a message event into the original v2 envelope, dropping the verification token", async () => {
    const flat = await throughSdk(messageRaw, "im.message.receive_v1");
    expect(worker.toEnvelope(flat)).toEqual({ schema: "2.0", header: withoutToken(messageRaw.header), event: messageRaw.event });
  });

  it("rebuilds a card click, keeping the card's own update token under event and dropping the header's", async () => {
    const flat = await throughSdk(cardRaw, "card.action.trigger");
    const out = worker.toEnvelope(flat);
    expect(out).toEqual({ schema: "2.0", header: withoutToken(cardRaw.header), event: cardRaw.event });
    expect(out.event.token).toBe("c-0123456789abcdef");
    expect(JSON.stringify(out)).not.toContain("app-verification-token");
  });

  it("produces something the relay route would accept", async () => {
    const m = worker.toEnvelope(await throughSdk(messageRaw, "im.message.receive_v1"));
    const c = worker.toEnvelope(await throughSdk(cardRaw, "card.action.trigger"));
    expect(relayRequestSchema.safeParse({ type: "event", payload: m }).success).toBe(true);
    expect(relayRequestSchema.safeParse({ type: "card", payload: c }).success).toBe(true);
  });
});
