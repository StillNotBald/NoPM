import { describe, it, expect } from "vitest";
import { AESCipher, EventDispatcher, LoggerLevel } from "@larksuiteoapi/node-sdk";
import {
  SIGNATURE_TOLERANCE_MS,
  computeLarkSignature,
  decryptLarkPayload,
  safeEqual,
  verifyLarkRequest,
} from "./verify";
import {
  FIXTURE_ENCRYPT_KEY,
  FIXTURE_VERIFICATION_TOKEN,
  cardActionEvent,
  encryptBody,
  messageEvent,
  signBody,
  urlVerificationBody,
} from "./fixtures";

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const nowSeconds = String(Math.floor(NOW / 1000));
const clock = () => NOW;

const plainSecrets = { verificationToken: FIXTURE_VERIFICATION_TOKEN, encryptKey: null };
const encSecrets = { verificationToken: FIXTURE_VERIFICATION_TOKEN, encryptKey: FIXTURE_ENCRYPT_KEY };

function encryptedSigned(event: unknown, overrides: { timestamp?: string; nonce?: string; encryptKey?: string } = {}) {
  const rawBody = encryptBody(JSON.stringify(event), overrides.encryptKey ?? FIXTURE_ENCRYPT_KEY);
  const headers = signBody({
    rawBody,
    encryptKey: overrides.encryptKey ?? FIXTURE_ENCRYPT_KEY,
    timestamp: overrides.timestamp ?? nowSeconds,
    nonce: overrides.nonce,
  });
  return { rawBody, headers };
}

describe("verifyLarkRequest - plaintext, verification token only", () => {
  it("accepts a schema-2.0 event with the right header.token", () => {
    const res = verifyLarkRequest({ rawBody: JSON.stringify(messageEvent()), headers: {}, secrets: plainSecrets, now: clock });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.encrypted).toBe(false);
      expect(res.envelope.header?.event_type).toBe("im.message.receive_v1");
    }
  });

  it("accepts a url_verification body with the right top-level token", () => {
    const res = verifyLarkRequest({ rawBody: JSON.stringify(urlVerificationBody()), headers: {}, secrets: plainSecrets, now: clock });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.envelope.challenge).toBe("challenge-fixture-abc");
  });

  it("rejects a wrong token", () => {
    const res = verifyLarkRequest({
      rawBody: JSON.stringify(messageEvent({ token: "not-the-token" })),
      headers: {},
      secrets: plainSecrets,
      now: clock,
    });
    expect(res).toEqual({ ok: false, reason: "bad_token" });
  });

  it("rejects a missing token", () => {
    const body = messageEvent();
    delete (body.header as { token?: string }).token;
    const res = verifyLarkRequest({ rawBody: JSON.stringify(body), headers: {}, secrets: plainSecrets, now: clock });
    expect(res).toEqual({ ok: false, reason: "bad_token" });
  });

  it("fails closed when the connector has no verification token configured", () => {
    const res = verifyLarkRequest({
      rawBody: JSON.stringify(messageEvent({ token: "" })),
      headers: {},
      secrets: { verificationToken: "", encryptKey: null },
      now: clock,
    });
    expect(res).toEqual({ ok: false, reason: "bad_token" });
  });

  it("rejects non-JSON and non-object bodies", () => {
    for (const rawBody of ["", "not json", "[1,2]", "null", "42"]) {
      expect(verifyLarkRequest({ rawBody, headers: {}, secrets: plainSecrets, now: clock })).toEqual({
        ok: false,
        reason: "bad_json",
      });
    }
  });

  it("rejects an encrypted body when no Encrypt Key is configured", () => {
    const rawBody = encryptBody(JSON.stringify(messageEvent()), FIXTURE_ENCRYPT_KEY);
    const res = verifyLarkRequest({ rawBody, headers: {}, secrets: plainSecrets, now: clock });
    expect(res).toEqual({ ok: false, reason: "encryption_not_configured" });
  });
});

describe("verifyLarkRequest - Encrypt Key configured", () => {
  it("accepts a signed + encrypted event and returns the decrypted envelope", () => {
    const { rawBody, headers } = encryptedSigned(messageEvent({ text: "link NPL-ABCD-1234" }));
    const res = verifyLarkRequest({ rawBody, headers, secrets: encSecrets, now: clock });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.encrypted).toBe(true);
      expect(res.envelope.header?.event_id).toBe("evt_msg_fixture_1");
    }
  });

  it("accepts a signed but unencrypted body (signature alone authenticates)", () => {
    const rawBody = JSON.stringify(cardActionEvent());
    const headers = signBody({ rawBody, encryptKey: FIXTURE_ENCRYPT_KEY, timestamp: nowSeconds });
    expect(verifyLarkRequest({ rawBody, headers, secrets: encSecrets, now: clock }).ok).toBe(true);
  });

  it("works with a Headers instance and mixed-case header names", () => {
    const { rawBody, headers } = encryptedSigned(cardActionEvent());
    const h = new Headers({
      "X-Lark-Request-Timestamp": headers["x-lark-request-timestamp"],
      "X-Lark-Request-Nonce": headers["x-lark-request-nonce"],
      "X-Lark-Signature": headers["x-lark-signature"],
    });
    expect(verifyLarkRequest({ rawBody, headers: h, secrets: encSecrets, now: clock }).ok).toBe(true);
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const { rawBody, headers } = encryptedSigned(messageEvent());
    const tampered = rawBody.replace('"encrypt":"', '"encrypt":"A');
    expect(verifyLarkRequest({ rawBody: tampered, headers, secrets: encSecrets, now: clock })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a signature made with the wrong Encrypt Key", () => {
    const rawBody = encryptBody(JSON.stringify(messageEvent()), FIXTURE_ENCRYPT_KEY);
    const headers = signBody({ rawBody, encryptKey: "some-other-key", timestamp: nowSeconds });
    expect(verifyLarkRequest({ rawBody, headers, secrets: encSecrets, now: clock })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a body encrypted under a different key even if correctly signed with ours", () => {
    const rawBody = encryptBody(JSON.stringify(messageEvent()), "attacker-key");
    const headers = signBody({ rawBody, encryptKey: FIXTURE_ENCRYPT_KEY, timestamp: nowSeconds });
    const res = verifyLarkRequest({ rawBody, headers, secrets: encSecrets, now: clock });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("decrypt_failed");
  });

  it("rejects a missing signature on a normal event (fail closed)", () => {
    const rawBody = encryptBody(JSON.stringify(messageEvent()), FIXTURE_ENCRYPT_KEY);
    expect(verifyLarkRequest({ rawBody, headers: {}, secrets: encSecrets, now: clock })).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it("rejects a plaintext unsigned event when an Encrypt Key is configured", () => {
    expect(
      verifyLarkRequest({ rawBody: JSON.stringify(cardActionEvent()), headers: {}, secrets: encSecrets, now: clock }),
    ).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("allows an unsigned url_verification handshake, but still demands the token", () => {
    const rawBody = encryptBody(JSON.stringify(urlVerificationBody()), FIXTURE_ENCRYPT_KEY);
    const ok = verifyLarkRequest({ rawBody, headers: {}, secrets: encSecrets, now: clock });
    expect(ok.ok).toBe(true);

    const badToken = encryptBody(JSON.stringify(urlVerificationBody("wrong-token")), FIXTURE_ENCRYPT_KEY);
    expect(verifyLarkRequest({ rawBody: badToken, headers: {}, secrets: encSecrets, now: clock })).toEqual({
      ok: false,
      reason: "bad_token",
    });
  });

  it("checks the signature of a url_verification request when one is present", () => {
    const rawBody = encryptBody(JSON.stringify(urlVerificationBody()), FIXTURE_ENCRYPT_KEY);
    const headers = signBody({ rawBody, encryptKey: "wrong", timestamp: nowSeconds });
    expect(verifyLarkRequest({ rawBody, headers, secrets: encSecrets, now: clock })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a valid signature whose token inside the body is wrong", () => {
    const { rawBody, headers } = encryptedSigned(messageEvent({ token: "wrong-token" }));
    expect(verifyLarkRequest({ rawBody, headers, secrets: encSecrets, now: clock })).toEqual({
      ok: false,
      reason: "bad_token",
    });
  });

  it("ignores unauthenticated fields next to `encrypt` in the outer object", () => {
    const encrypted = JSON.parse(encryptBody(JSON.stringify(messageEvent({ text: "help" })), FIXTURE_ENCRYPT_KEY));
    const rawBody = JSON.stringify({ ...encrypted, header: { event_type: "card.action.trigger", token: FIXTURE_VERIFICATION_TOKEN } });
    const headers = signBody({ rawBody, encryptKey: FIXTURE_ENCRYPT_KEY, timestamp: nowSeconds });
    const res = verifyLarkRequest({ rawBody, headers, secrets: encSecrets, now: clock });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.envelope.header?.event_type).toBe("im.message.receive_v1");
  });

  describe("timestamp window", () => {
    it("accepts the edges of the +-5 minute window", () => {
      for (const delta of [-SIGNATURE_TOLERANCE_MS, SIGNATURE_TOLERANCE_MS, 0]) {
        const ts = String(Math.floor((NOW + delta) / 1000));
        const { rawBody, headers } = encryptedSigned(messageEvent(), { timestamp: ts });
        expect(verifyLarkRequest({ rawBody, headers, secrets: encSecrets, now: clock }).ok).toBe(true);
      }
    });

    it("rejects stale and future timestamps", () => {
      for (const delta of [-(SIGNATURE_TOLERANCE_MS + 2000), SIGNATURE_TOLERANCE_MS + 2000, -3_600_000]) {
        const ts = String(Math.floor((NOW + delta) / 1000));
        const { rawBody, headers } = encryptedSigned(messageEvent(), { timestamp: ts });
        expect(verifyLarkRequest({ rawBody, headers, secrets: encSecrets, now: clock })).toEqual({
          ok: false,
          reason: "stale_timestamp",
        });
      }
    });

    it("tolerates a millisecond timestamp and rejects garbage", () => {
      const ms = encryptedSigned(messageEvent(), { timestamp: String(NOW) });
      expect(verifyLarkRequest({ rawBody: ms.rawBody, headers: ms.headers, secrets: encSecrets, now: clock }).ok).toBe(true);
      const bad = encryptedSigned(messageEvent(), { timestamp: "yesterday" });
      expect(verifyLarkRequest({ rawBody: bad.rawBody, headers: bad.headers, secrets: encSecrets, now: clock })).toEqual({
        ok: false,
        reason: "stale_timestamp",
      });
    });
  });
});

describe("primitives", () => {
  it("computeLarkSignature matches the documented concatenation", () => {
    const rawBody = '{"a":1}';
    const sig = computeLarkSignature({ timestamp: "1", nonce: "2", encryptKey: "k", rawBody });
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sig).toBe(signBody({ rawBody, encryptKey: "k", timestamp: "1", nonce: "2" })["x-lark-signature"]);
  });

  it("decryptLarkPayload rejects short / unaligned ciphertext", () => {
    expect(() => decryptLarkPayload("AAAA", "k")).toThrow();
    expect(() => decryptLarkPayload(Buffer.alloc(40).toString("base64"), "k")).toThrow();
  });

  it("safeEqual compares by value regardless of length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("compatibility with the official SDK", () => {
  it("decrypts exactly like the SDK's AESCipher", () => {
    const plaintext = JSON.stringify(messageEvent({ text: "unicode 你好 🌏" }));
    const outer = JSON.parse(encryptBody(plaintext, FIXTURE_ENCRYPT_KEY)) as { encrypt: string };
    expect(decryptLarkPayload(outer.encrypt, FIXTURE_ENCRYPT_KEY)).toBe(plaintext);
    expect(new AESCipher(FIXTURE_ENCRYPT_KEY).decrypt(outer.encrypt)).toBe(plaintext);
  });

  it("produces a signature the SDK's own EventDispatcher accepts (compact JSON)", async () => {
    const body = messageEvent();
    const rawBody = JSON.stringify(body);
    const headers = signBody({ rawBody, encryptKey: FIXTURE_ENCRYPT_KEY, timestamp: nowSeconds });

    const noop = () => undefined;
    const dispatcher = new EventDispatcher({
      encryptKey: FIXTURE_ENCRYPT_KEY,
      verificationToken: FIXTURE_VERIFICATION_TOKEN,
      loggerLevel: LoggerLevel.fatal,
      logger: { error: noop, warn: noop, info: noop, debug: noop, trace: noop },
    });
    let called = 0;
    dispatcher.register({
      "im.message.receive_v1": async () => {
        called += 1;
        return "handled";
      },
    });

    // The SDK reads headers off the prototype of the parsed body.
    const data = Object.assign(Object.create({ headers }), body);
    expect(await dispatcher.invoke(data)).toBe("handled");
    expect(called).toBe(1);

    // ...and rejects the same payload with a corrupted signature, as do we.
    const badHeaders = { ...headers, "x-lark-signature": "0".repeat(64) };
    const badData = Object.assign(Object.create({ headers: badHeaders }), body);
    expect(await dispatcher.invoke(badData)).toBeUndefined();
    expect(verifyLarkRequest({ rawBody, headers: badHeaders, secrets: encSecrets, now: clock }).ok).toBe(false);
    expect(verifyLarkRequest({ rawBody, headers, secrets: encSecrets, now: clock }).ok).toBe(true);
  });
});
