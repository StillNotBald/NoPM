import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FIXTURE_BOT_TOKEN, FIXTURE_CONNECTOR_ID, FIXTURE_WEBHOOK_SECRET, FIXTURE_WORKSPACE_ID, fixtureConnector } from "@/lib/integrations/telegram/fixtures";

const m = vi.hoisted(() => ({ requireAuth: vi.fn(), get: vi.fn(), register: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ data: { allowed: true, retry_after_seconds: 0 }, error: null }) }),
}));
vi.mock("@/lib/auth/guard", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/guard")>()), requireAuth: m.requireAuth }));
vi.mock("@/lib/integrations/telegram/store", async (orig) => ({ ...(await orig<typeof import("@/lib/integrations/telegram/store")>()), getTelegramConnector: m.get }));
vi.mock("@/lib/integrations/telegram/setup", () => ({ registerTelegram: m.register }));
vi.mock("@/lib/integrations/telegram/secrets", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/telegram/secrets")>()),
  readTelegramSecrets: () => ({ botToken: FIXTURE_BOT_TOKEN, webhookSecret: FIXTURE_WEBHOOK_SECRET }),
}));

import { POST } from "./route";

const admin = (over: Partial<Actor> = {}): Actor => ({ type: "user", id: "adm", label: "Ada", workspaceId: FIXTURE_WORKSPACE_ID, role: "admin", ...over });
const call = () =>
  POST(new NextRequest(`https://nopm.example.test/api/integrations/telegram/${FIXTURE_CONNECTOR_ID}/setup`, { method: "POST" }), {
    params: Promise.resolve({ connectorId: FIXTURE_CONNECTOR_ID }),
  });

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.requireAuth.mockResolvedValue(admin());
  m.get.mockResolvedValue(fixtureConnector());
  m.register.mockResolvedValue({ ok: true, botUsername: "example_bot" });
});

describe("POST .../setup", () => {
  it("registers the webhook and menu and reports the bot name", async () => {
    const body = await (await call()).json();
    expect(m.register).toHaveBeenCalledWith(expect.objectContaining({ id: FIXTURE_CONNECTOR_ID }), "https://nopm.example.test");
    expect(body.data).toEqual({ ok: true, bot_username: "example_bot" });
  });

  it("always answers 200 with ok:false and a token-free error when Telegram refuses", async () => {
    m.register.mockResolvedValue({ ok: false, step: "webhook", error: `bad ${FIXTURE_BOT_TOKEN}` });
    const res = await call();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ ok: false, step: "webhook" });
    expect(JSON.stringify(body)).not.toContain(FIXTURE_BOT_TOKEN);
  });

  it("is admin-session only, workspace-scoped, and refuses a revoked connector", async () => {
    m.requireAuth.mockResolvedValue(admin({ role: "member" }));
    expect((await call()).status).toBe(403);
    m.requireAuth.mockResolvedValue(admin());
    m.get.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(m.get).toHaveBeenCalledWith(FIXTURE_WORKSPACE_ID, FIXTURE_CONNECTOR_ID);
    m.get.mockResolvedValue(fixtureConnector({ status: "revoked" }));
    expect((await call()).status).toBe(422);
    expect(m.register).not.toHaveBeenCalled();
  });
});
