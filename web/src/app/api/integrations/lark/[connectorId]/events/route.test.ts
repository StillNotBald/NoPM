/**
 * POST /api/integrations/lark/[connectorId]/events - thin wrapper over
 * handleLarkWebhook; the hub dependencies are injected through a mocked wiring
 * module, so this asserts only the route's own behaviour: it is public
 * (auth:false), forwards the connector id, and returns the platform-shaped body.
 * The authentication / dispatch matrix lives in lib/integrations/lark/http.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WebhookDeps } from "@/lib/integrations/lark/http";
import {
  FIXTURE_APP_URL,
  FIXTURE_CONNECTOR_ID,
  fakeHandlerDeps,
  fixtureConnector,
  fixtureSecrets,
  messageEvent,
  urlVerificationBody,
} from "@/lib/integrations/lark/fixtures";

const hub = fakeHandlerDeps();
const deps: WebhookDeps = {
  loadConnector: vi.fn(async (id: string) => (id === FIXTURE_CONNECTOR_ID ? fixtureConnector() : null)),
  readSecrets: () => fixtureSecrets(),
  rateCheck: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  buildContext: (connector, secrets) => ({ ctx: { connector, secrets, appUrl: FIXTURE_APP_URL }, deps: hub.deps }),
  now: Date.now,
  log: () => undefined,
};

vi.mock("@/lib/integrations/lark/wiring", () => ({ productionWebhookDeps: () => deps }));

import { POST } from "./route";

const call = (body: unknown, id = FIXTURE_CONNECTOR_ID) =>
  POST(
    new NextRequest(`https://nopm.example.test/api/integrations/lark/${id}/events`, { method: "POST", body: JSON.stringify(body) }),
    { params: Promise.resolve({ connectorId: id }) },
  );

describe("POST /api/integrations/lark/[connectorId]/events", () => {
  it("answers the url_verification handshake without any session or token", async () => {
    const res = await call(urlVerificationBody());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "challenge-fixture-abc" });
  });

  it("acknowledges a bot DM and replies through the hub", async () => {
    const res = await call(messageEvent({ text: "help" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(hub.sent).toHaveLength(1);
  });

  it("401s a request that fails authentication", async () => {
    const res = await call(messageEvent({ token: "wrong" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid request" });
  });

  it("404s an unknown connector", async () => {
    const other = "99999999-9999-4999-8999-999999999999";
    expect((await call(urlVerificationBody(), other)).status).toBe(404);
  });
});
