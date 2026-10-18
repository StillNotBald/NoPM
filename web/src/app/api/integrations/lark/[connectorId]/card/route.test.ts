/**
 * POST /api/integrations/lark/[connectorId]/card - thin wrapper over
 * handleLarkWebhook; the hub dependencies are injected through a mocked wiring
 * module. Asserts the route's contract with the platform: a verified click
 * reaches the hub's inbound pipeline and the reply is `{ toast, card? }` with
 * HTTP 200 (never the NoPM `{ data }` envelope).
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import type { WebhookDeps } from "@/lib/integrations/lark/http";
import {
  FIXTURE_APP_URL,
  FIXTURE_CONNECTOR_ID,
  FIXTURE_ENCRYPT_KEY,
  cardActionEvent,
  encryptBody,
  fakeHandlerDeps,
  fixtureConnector,
  fixtureSecrets,
  signBody,
} from "@/lib/integrations/lark/fixtures";

const hub = fakeHandlerDeps();
const deps: WebhookDeps = {
  loadConnector: async () => fixtureConnector(),
  readSecrets: () => fixtureSecrets({ encryptKey: FIXTURE_ENCRYPT_KEY }),
  rateCheck: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  buildContext: (connector, secrets) => ({ ctx: { connector, secrets, appUrl: FIXTURE_APP_URL }, deps: hub.deps }),
  now: Date.now,
  log: () => undefined,
};

vi.mock("@/lib/integrations/lark/wiring", () => ({ productionWebhookDeps: () => deps }));

import { POST } from "./route";

function signedClick(overrides: Parameters<typeof cardActionEvent>[0] = {}) {
  const rawBody = encryptBody(JSON.stringify(cardActionEvent(overrides)), FIXTURE_ENCRYPT_KEY);
  return new NextRequest(`https://nopm.example.test/api/integrations/lark/${FIXTURE_CONNECTOR_ID}/card`, {
    method: "POST",
    body: rawBody,
    headers: signBody({ rawBody, encryptKey: FIXTURE_ENCRYPT_KEY }),
  });
}

const ctx = { params: Promise.resolve({ connectorId: FIXTURE_CONNECTOR_ID }) };

describe("POST /api/integrations/lark/[connectorId]/card", () => {
  it("runs a signed, encrypted approve click through the hub and replies with toast + replacement card", async () => {
    const res = await POST(signedClick({ eventId: "evt_route_1", value: { t: "tok-route", a: "approve" } }), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["card", "toast"]);
    expect(body).not.toHaveProperty("data");
    expect(hub.deps.handleApprovalAction).toHaveBeenCalledWith(
      expect.objectContaining({ externalEventId: "evt_route_1", actionToken: "tok-route", action: "approve" }),
    );
  });

  it("rejects an unsigned click when an Encrypt Key is configured", async () => {
    const before = (hub.deps.handleApprovalAction as ReturnType<typeof vi.fn>).mock.calls.length;
    const req = new NextRequest(`https://nopm.example.test/api/integrations/lark/${FIXTURE_CONNECTOR_ID}/card`, {
      method: "POST",
      body: JSON.stringify(cardActionEvent()),
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    expect((hub.deps.handleApprovalAction as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });
});
