import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { handleTelegramWebhook, MAX_UPDATE_BODY_BYTES, SECRET_HEADER, WEBHOOK_BAD_ATTEMPTS_MAX, type TelegramWebhookDeps } from "./webhook";
import { FIXTURE_CONNECTOR_ID, FIXTURE_WEBHOOK_SECRET, fakeDeps, fixtureConnector, messageUpdate } from "./fixtures";
import type { ConnectorRow } from "@/lib/integrations/types";

function setup(connector: ConnectorRow | null = fixtureConnector(), over: Partial<TelegramWebhookDeps> = {}) {
  const h = fakeDeps();
  const deps: TelegramWebhookDeps = {
    loadConnector: vi.fn(async (id: string) => (connector && id === connector.id ? connector : null)),
    readSecrets: () => ({ botToken: "123456:EXAMPLE-token-value", webhookSecret: FIXTURE_WEBHOOK_SECRET }),
    rateCheck: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
    buildContext: (c) => ({ ctx: { connector: c }, deps: h.deps }),
    log: vi.fn(),
    ...over,
  };
  return { h, deps };
}

const req = (body: unknown, secret: string | null = FIXTURE_WEBHOOK_SECRET, id = FIXTURE_CONNECTOR_ID) =>
  new NextRequest(`https://nopm.example.test/api/integrations/telegram/${id}/webhook`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: secret === null ? {} : { [SECRET_HEADER]: secret },
  });

describe("telegram webhook", () => {
  it("a matching secret token is accepted: 200 at once, reply sent", async () => {
    const { h, deps } = setup();
    const res = await handleTelegramWebhook(req(messageUpdate({ text: "/0" })), FIXTURE_CONNECTOR_ID, deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(h.sent).toHaveLength(1);
  });

  it.each([
    ["a wrong secret", "wrong-secret"],
    ["no secret header", null],
    ["an empty secret", ""],
    ["a near-miss (one character off)", FIXTURE_WEBHOOK_SECRET.slice(0, -1) + "X"],
    ["a longer secret with the right prefix", FIXTURE_WEBHOOK_SECRET + "extra"],
  ])("%s -> one generic 401 and nothing runs", async (_label, secret) => {
    const { h, deps } = setup();
    const res = await handleTelegramWebhook(req(messageUpdate({ text: "/0" }), secret), FIXTURE_CONNECTOR_ID, deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid request" });
    expect(h.sent).toHaveLength(0);
  });

  it("an unknown connector looks exactly like a wrong secret", async () => {
    const { deps } = setup(null);
    const res = await handleTelegramWebhook(req(messageUpdate({ text: "/0" })), FIXTURE_CONNECTOR_ID, deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid request" });
  });

  it("a revoked connector is a 401 even with the right secret", async () => {
    const { h, deps } = setup(fixtureConnector({ status: "revoked" }));
    const res = await handleTelegramWebhook(req(messageUpdate({ text: "/0" })), FIXTURE_CONNECTOR_ID, deps);
    expect(res.status).toBe(401);
    expect(h.sent).toHaveLength(0);
  });

  it("a paused connector is authenticated and the bot answers 'turned off'", async () => {
    const { h, deps } = setup(fixtureConnector({ status: "paused" }));
    const res = await handleTelegramWebhook(req(messageUpdate({ text: "/1" })), FIXTURE_CONNECTOR_ID, deps);
    expect(res.status).toBe(200);
    expect(h.sent[0].msg.text).toContain("turned off");
  });

  it("failed attempts are counted per connector and become a 429 when they pile up", async () => {
    const rateCheck = vi.fn(async (key: string) => ({ allowed: !key.startsWith("telegram-bad:"), retryAfterSeconds: 30 }));
    const { deps } = setup(fixtureConnector(), { rateCheck });
    const res = await handleTelegramWebhook(req({}, "nope"), FIXTURE_CONNECTOR_ID, deps);
    expect(rateCheck).toHaveBeenCalledWith(`telegram-bad:${FIXTURE_CONNECTOR_ID}`, WEBHOOK_BAD_ATTEMPTS_MAX);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
  });

  it("no counter row is keyed by a connector id the caller picked", async () => {
    const rateCheck = vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 }));
    const { deps } = setup(null, { rateCheck });
    await handleTelegramWebhook(req({}), "99999999-9999-4999-8999-999999999999", deps);
    expect(rateCheck).not.toHaveBeenCalled();
  });

  it("the per-connector budget answers 429 with Retry-After", async () => {
    const { deps } = setup(fixtureConnector(), { rateCheck: async () => ({ allowed: false, retryAfterSeconds: 12 }) });
    const res = await handleTelegramWebhook(req(messageUpdate({ text: "/0" })), FIXTURE_CONNECTOR_ID, deps);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
  });

  it("a malformed connector id is a 404", async () => {
    const { deps } = setup();
    const res = await handleTelegramWebhook(req({}), "not-a-uuid", deps);
    expect(res.status).toBe(404);
  });

  it("an oversize body is a 413, declared or streamed", async () => {
    const { deps } = setup();
    const big = "x".repeat(MAX_UPDATE_BODY_BYTES + 10);
    const res = await handleTelegramWebhook(req(big), FIXTURE_CONNECTOR_ID, deps);
    expect(res.status).toBe(413);
  });

  it("an authenticated body that is not JSON is acknowledged and ignored", async () => {
    const { h, deps } = setup();
    const res = await handleTelegramWebhook(req("not json"), FIXTURE_CONNECTOR_ID, deps);
    expect(res.status).toBe(200);
    expect(h.sent).toHaveLength(0);
  });

  it("unreadable secrets are a 503, not a 401 (an operator fault)", async () => {
    const { deps } = setup(fixtureConnector(), {
      readSecrets: () => {
        throw new Error("bad key");
      },
    });
    const res = await handleTelegramWebhook(req(messageUpdate({ text: "/0" })), FIXTURE_CONNECTOR_ID, deps);
    expect(res.status).toBe(503);
  });

  it("never logs the body or the secret", async () => {
    const { deps } = setup();
    await handleTelegramWebhook(req(messageUpdate({ text: "private words" }), "wrong"), FIXTURE_CONNECTOR_ID, deps);
    const logged = JSON.stringify((deps.log as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain("private words");
    expect(logged).not.toContain(FIXTURE_WEBHOOK_SECRET);
  });
});
