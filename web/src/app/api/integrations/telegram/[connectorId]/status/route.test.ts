import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FIXTURE_BOT_TOKEN, FIXTURE_CONNECTOR_ID, FIXTURE_WEBHOOK_SECRET, FIXTURE_WORKSPACE_ID, fixtureConnector } from "@/lib/integrations/telegram/fixtures";

const m = vi.hoisted(() => ({ requireAuth: vi.fn(), get: vi.fn(), last: vi.fn(), info: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ data: { allowed: true, retry_after_seconds: 0 }, error: null }) }),
}));
vi.mock("@/lib/auth/guard", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/guard")>()), requireAuth: m.requireAuth }));
vi.mock("@/lib/integrations/telegram/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/telegram/store")>()),
  getTelegramConnector: m.get,
  lastTelegramUpdateAt: m.last,
}));
vi.mock("@/lib/integrations/telegram/http", async (orig) => ({ ...(await orig<typeof import("@/lib/integrations/telegram/http")>()), getWebhookInfo: m.info }));
vi.mock("@/lib/integrations/telegram/secrets", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/telegram/secrets")>()),
  readTelegramSecrets: () => ({ botToken: FIXTURE_BOT_TOKEN, webhookSecret: FIXTURE_WEBHOOK_SECRET }),
}));

import { GET } from "./route";

const admin = (over: Partial<Actor> = {}): Actor => ({ type: "user", id: "adm", label: "Ada", workspaceId: FIXTURE_WORKSPACE_ID, role: "admin", ...over });
const URL_OK = `https://nopm.example.test/api/integrations/telegram/${FIXTURE_CONNECTOR_ID}/webhook`;
const call = () =>
  GET(new NextRequest(`https://nopm.example.test/api/integrations/telegram/${FIXTURE_CONNECTOR_ID}/status`), {
    params: Promise.resolve({ connectorId: FIXTURE_CONNECTOR_ID }),
  });

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.requireAuth.mockResolvedValue(admin());
  m.get.mockResolvedValue(fixtureConnector());
  m.last.mockResolvedValue("2026-11-03T00:05:00.000Z");
  m.info.mockResolvedValue({ ok: true, result: { url: URL_OK, pending_update_count: 0 } });
});

describe("GET .../status", () => {
  it("reports ok when Telegram has this connector URL and no delivery error", async () => {
    const { data } = await (await call()).json();
    expect(data).toEqual({ webhook: "ok", detail: null, pending_updates: 0, last_update_at: "2026-11-03T00:05:00.000Z" });
  });

  it("reports an error for a different or missing URL, and for a failed delivery, with the token removed", async () => {
    m.info.mockResolvedValue({ ok: true, result: { url: "https://elsewhere.example/hook" } });
    expect((await (await call()).json()).data.webhook).toBe("error");
    m.info.mockResolvedValue({ ok: true, result: {} });
    expect((await (await call()).json()).data.webhook).toBe("error");
    m.info.mockResolvedValue({ ok: true, result: { url: URL_OK, last_error_message: `Wrong response from ${FIXTURE_BOT_TOKEN}` } });
    const body = await (await call()).json();
    expect(body.data.webhook).toBe("error");
    expect(JSON.stringify(body)).not.toContain(FIXTURE_BOT_TOKEN);
  });

  it("reports an error when Telegram cannot be reached", async () => {
    m.info.mockResolvedValue({ ok: false, error: "Telegram did not answer in time", status: 0, retryable: true });
    expect((await (await call()).json()).data).toMatchObject({ webhook: "error", detail: "Telegram did not answer in time" });
  });

  it("is admin-only, workspace-scoped and refuses a revoked connector", async () => {
    m.requireAuth.mockResolvedValue(admin({ role: "member" }));
    expect((await call()).status).toBe(403);
    m.requireAuth.mockResolvedValue(admin());
    m.get.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    m.get.mockResolvedValue(fixtureConnector({ status: "revoked" }));
    expect((await call()).status).toBe(422);
  });
});
