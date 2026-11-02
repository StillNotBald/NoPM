/**
 * POST /api/integrations/telegram/[connectorId]/webhook - thin wrapper over
 * handleTelegramWebhook; hub dependencies come from a mocked wiring module, so
 * this asserts only the route's own behaviour: public (auth:false), forwards the
 * connector id, 401 on a bad secret token, 200 on a good one. The full matrix is
 * in lib/integrations/telegram/webhook.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import type { TelegramWebhookDeps } from "@/lib/integrations/telegram/webhook";
import { FIXTURE_CONNECTOR_ID, FIXTURE_WEBHOOK_SECRET, fakeDeps, fixtureConnector, messageUpdate } from "@/lib/integrations/telegram/fixtures";

const hub = fakeDeps();
const deps: TelegramWebhookDeps = {
  loadConnector: vi.fn(async (id: string) => (id === FIXTURE_CONNECTOR_ID ? fixtureConnector() : null)),
  readSecrets: () => ({ botToken: "123456:EXAMPLE-token-value", webhookSecret: FIXTURE_WEBHOOK_SECRET }),
  rateCheck: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  buildContext: (connector) => ({ ctx: { connector }, deps: hub.deps }),
  log: () => undefined,
};

vi.mock("@/lib/integrations/telegram/wiring", () => ({ productionWebhookDeps: () => deps }));

import { POST } from "./route";

const call = (body: unknown, secret: string | null = FIXTURE_WEBHOOK_SECRET, id = FIXTURE_CONNECTOR_ID) =>
  POST(
    new NextRequest(`https://nopm.example.test/api/integrations/telegram/${id}/webhook`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: secret === null ? {} : { "X-Telegram-Bot-Api-Secret-Token": secret },
    }),
    { params: Promise.resolve({ connectorId: id }) },
  );

describe("POST /api/integrations/telegram/[connectorId]/webhook", () => {
  it("is public: a good secret token needs no session or bearer, and a reply goes out", async () => {
    const res = await call(messageUpdate({ text: "/0" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(hub.sent).toHaveLength(1);
  });

  it("401s a wrong or missing secret token with one generic body", async () => {
    for (const secret of ["wrong", null]) {
      const res = await call(messageUpdate({ text: "/0" }), secret);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid request" });
    }
  });

  it("401s an unknown connector the same way, and 404s a malformed id", async () => {
    const unknown = await call({}, FIXTURE_WEBHOOK_SECRET, "99999999-9999-4999-8999-999999999999");
    expect(unknown.status).toBe(401);
    const bad = await call({}, FIXTURE_WEBHOOK_SECRET, "nope");
    expect(bad.status).toBe(404);
  });
});
