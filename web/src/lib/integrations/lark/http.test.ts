import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { WEBHOOK_BAD_ATTEMPTS_MAX, WEBHOOK_RATE_MAX, handleLarkWebhook, type WebhookDeps } from "./http";
import { MAX_WEBHOOK_BODY_BYTES } from "./verify";
import {
  FIXTURE_APP_URL,
  FIXTURE_CONNECTOR_ID,
  FIXTURE_ENCRYPT_KEY,
  cardActionEvent,
  encryptBody,
  fakeHandlerDeps,
  fixtureConfig,
  fixtureConnector,
  fixtureSecrets,
  messageEvent,
  signBody,
  urlVerificationBody,
} from "./fixtures";

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const ts = String(Math.floor(NOW / 1000));

function setup(over: Partial<WebhookDeps> = {}) {
  const hub = fakeHandlerDeps();
  const rateCheck = vi.fn<WebhookDeps["rateCheck"]>(async () => ({ allowed: true, retryAfterSeconds: 0 }));
  const wd: WebhookDeps = {
    loadConnector: vi.fn(async () => fixtureConnector()),
    readSecrets: vi.fn(() => fixtureSecrets()),
    rateCheck,
    buildContext: (connector, secrets) => ({ ctx: { connector, secrets, appUrl: FIXTURE_APP_URL }, deps: hub.deps }),
    now: () => NOW,
    log: vi.fn(),
    ...over,
  };
  return { wd, hub, rateCheck };
}

function post(body: string, headers: Record<string, string> = {}, id = FIXTURE_CONNECTOR_ID) {
  return new NextRequest(`https://nopm.example.test/api/integrations/lark/${id}/events`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
}

const plain = (obj: unknown) => post(JSON.stringify(obj));

function signedEncrypted(obj: unknown) {
  const rawBody = encryptBody(JSON.stringify(obj), FIXTURE_ENCRYPT_KEY);
  return post(rawBody, signBody({ rawBody, encryptKey: FIXTURE_ENCRYPT_KEY, timestamp: ts }));
}

const encSecrets = () => fixtureSecrets({ encryptKey: FIXTURE_ENCRYPT_KEY });

describe("handleLarkWebhook - routing and lookup", () => {
  it("404s a malformed connector id without touching the database", async () => {
    const { wd } = setup();
    const res = await handleLarkWebhook(plain(urlVerificationBody()), "not-a-uuid", wd);
    expect(res.status).toBe(404);
    expect(wd.loadConnector).not.toHaveBeenCalled();
  });

  it("404s unknown, paused and revoked connectors alike", async () => {
    for (const row of [null, fixtureConnector({ status: "paused" }), fixtureConnector({ status: "revoked" })]) {
      const { wd } = setup({ loadConnector: vi.fn(async () => row) });
      const res = await handleLarkWebhook(plain(urlVerificationBody()), FIXTURE_CONNECTOR_ID, wd);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
  });

  it("canonicalises the connector id so a differently-cased uuid cannot open a second rate bucket", async () => {
    const mixed = "abcdefab-1111-4111-8111-abcdefabcdef";
    const { wd, rateCheck } = setup({ loadConnector: vi.fn(async () => fixtureConnector({ id: mixed })) });
    await handleLarkWebhook(plain(messageEvent()), mixed.toUpperCase(), wd);
    expect(wd.loadConnector).toHaveBeenCalledWith(mixed);
    expect(rateCheck).toHaveBeenCalledWith(`lark:${mixed}`, WEBHOOK_RATE_MAX);
  });

  it("413s an oversized declared or actual body", async () => {
    const { wd } = setup();
    const declared = post("{}", { "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1) });
    expect((await handleLarkWebhook(declared, FIXTURE_CONNECTOR_ID, wd)).status).toBe(413);
    const actual = post(JSON.stringify({ pad: "x".repeat(MAX_WEBHOOK_BODY_BYTES) }));
    expect((await handleLarkWebhook(actual, FIXTURE_CONNECTOR_ID, wd)).status).toBe(413);
  });

  it("500s (and logs) when the stored secrets cannot be read", async () => {
    const { wd } = setup({
      readSecrets: vi.fn(() => {
        throw new Error("bad key");
      }),
    });
    const res = await handleLarkWebhook(plain(messageEvent()), FIXTURE_CONNECTOR_ID, wd);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("bad key");
  });
});

describe("handleLarkWebhook - authentication", () => {
  it("answers the url_verification handshake", async () => {
    const { wd } = setup();
    const res = await handleLarkWebhook(plain(urlVerificationBody()), FIXTURE_CONNECTOR_ID, wd);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "challenge-fixture-abc" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers an encrypted, unsigned handshake when an Encrypt Key is configured", async () => {
    const { wd } = setup({ readSecrets: vi.fn(encSecrets) });
    const req = post(encryptBody(JSON.stringify(urlVerificationBody()), FIXTURE_ENCRYPT_KEY));
    const res = await handleLarkWebhook(req, FIXTURE_CONNECTOR_ID, wd);
    expect(await res.json()).toEqual({ challenge: "challenge-fixture-abc" });
  });

  it("401s a wrong token with ONE generic body, whatever the real reason", async () => {
    const bodies = new Set<string>();
    const { wd } = setup({ readSecrets: vi.fn(encSecrets) });
    const reqs = [
      plain(messageEvent({ token: "wrong" })), // unsigned
      post("not json"),
      signedEncrypted(messageEvent({ token: "wrong" })),
      (() => {
        const rawBody = encryptBody(JSON.stringify(messageEvent()), FIXTURE_ENCRYPT_KEY);
        return post(rawBody, signBody({ rawBody, encryptKey: "other", timestamp: ts }));
      })(),
    ];
    for (const req of reqs) {
      const res = await handleLarkWebhook(req, FIXTURE_CONNECTOR_ID, wd);
      expect(res.status).toBe(401);
      bodies.add(JSON.stringify(await res.json()));
    }
    expect([...bodies]).toEqual([JSON.stringify({ error: "Invalid request" })]);
    // The reasons are for the server log only.
    const reasons = (wd.log as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2].reason);
    expect(reasons).toEqual(["missing_signature", "bad_json", "bad_token", "bad_signature"]);
  });

  it("never runs a handler for an unauthenticated request", async () => {
    const { wd, hub } = setup();
    await handleLarkWebhook(plain(cardActionEvent({ token: "wrong" })), FIXTURE_CONNECTOR_ID, wd);
    await handleLarkWebhook(plain(messageEvent({ token: "wrong" })), FIXTURE_CONNECTOR_ID, wd);
    expect(hub.deps.handleApprovalAction).not.toHaveBeenCalled();
    expect(hub.deps.send).not.toHaveBeenCalled();
    expect(hub.deps.claimEvent).not.toHaveBeenCalled();
  });

  it("counts failed attempts in their own bucket and throttles a guessing run", async () => {
    const { wd, rateCheck } = setup({});
    (rateCheck as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ allowed: false, retryAfterSeconds: 42 });
    const res = await handleLarkWebhook(plain(messageEvent({ token: "wrong" })), FIXTURE_CONNECTOR_ID, wd);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(rateCheck).toHaveBeenCalledWith(`lark-bad:${FIXTURE_CONNECTOR_ID}`, WEBHOOK_BAD_ATTEMPTS_MAX);
  });

  it("only reveals 'wrong mode' to an authenticated caller", async () => {
    const longConn = fixtureConnector({ config: fixtureConfig({ mode: "long_connection" }) });
    const { wd } = setup({ loadConnector: vi.fn(async () => longConn) });
    expect((await handleLarkWebhook(plain(messageEvent({ token: "wrong" })), FIXTURE_CONNECTOR_ID, wd)).status).toBe(401);
    const ok = await handleLarkWebhook(plain(messageEvent()), FIXTURE_CONNECTOR_ID, wd);
    expect(ok.status).toBe(403);
    expect(await ok.json()).toMatchObject({ code: "wrong_mode" });
  });
});

describe("handleLarkWebhook - dispatch", () => {
  it("runs an approval click end to end and returns toast + replacement card", async () => {
    const { wd, hub } = setup({ readSecrets: vi.fn(encSecrets) });
    const res = await handleLarkWebhook(signedEncrypted(cardActionEvent({ eventId: "evt_click", value: { t: "tok", a: "approve" } })), FIXTURE_CONNECTOR_ID, wd);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { toast: { type: string }; card: { type: string; data: { schema: string } } };
    expect(body.toast.type).toBe("success");
    expect(body.card.data.schema).toBe("2.0");
    expect(hub.deps.handleApprovalAction).toHaveBeenCalledWith(expect.objectContaining({ externalEventId: "evt_click", actionToken: "tok" }));
  });

  it("accepts a card callback on the events URL and a message event on the card URL (one URL for both fields works)", async () => {
    const { wd, hub } = setup();
    const card = await handleLarkWebhook(plain(cardActionEvent()), FIXTURE_CONNECTOR_ID, wd);
    expect(((await card.json()) as { toast: unknown }).toast).toBeDefined();
    const msg = await handleLarkWebhook(plain(messageEvent()), FIXTURE_CONNECTOR_ID, wd);
    expect(await msg.json()).toEqual({});
    expect(hub.sent).toHaveLength(1);
  });

  it("acknowledges unrelated events with an empty object", async () => {
    const { wd } = setup();
    const body = { schema: "2.0", header: { event_id: "e", event_type: "im.chat.updated_v1", token: fixtureSecrets().verificationToken, app_id: "cli_fixture_app" }, event: {} };
    const res = await handleLarkWebhook(plain(body), FIXTURE_CONNECTOR_ID, wd);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});

describe("handleLarkWebhook - rate limit", () => {
  const exhausted = (key: string) => key === `lark:${FIXTURE_CONNECTOR_ID}`;

  it("charges the per-connector bucket only after authentication", async () => {
    const { wd, rateCheck } = setup();
    await handleLarkWebhook(plain(messageEvent({ token: "wrong" })), FIXTURE_CONNECTOR_ID, wd);
    expect(rateCheck).not.toHaveBeenCalledWith(`lark:${FIXTURE_CONNECTOR_ID}`, expect.anything());
    await handleLarkWebhook(plain(messageEvent()), FIXTURE_CONNECTOR_ID, wd);
    expect(rateCheck).toHaveBeenCalledWith(`lark:${FIXTURE_CONNECTOR_ID}`, WEBHOOK_RATE_MAX);
  });

  it("answers a rate-limited card click with HTTP 200 and a toast", async () => {
    const { wd, hub } = setup({ rateCheck: vi.fn(async (key: string) => ({ allowed: !exhausted(key), retryAfterSeconds: 9 })) });
    const res = await handleLarkWebhook(plain(cardActionEvent()), FIXTURE_CONNECTOR_ID, wd);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { toast: { type: string } }).toast.type).toBe("warning");
    expect(hub.deps.handleApprovalAction).not.toHaveBeenCalled();
  });

  it("429s a rate-limited event with Retry-After", async () => {
    const { wd, hub } = setup({ rateCheck: vi.fn(async (key: string) => ({ allowed: !exhausted(key), retryAfterSeconds: 9 })) });
    const res = await handleLarkWebhook(plain(messageEvent()), FIXTURE_CONNECTOR_ID, wd);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("9");
    expect(hub.sent).toHaveLength(0);
  });
});
