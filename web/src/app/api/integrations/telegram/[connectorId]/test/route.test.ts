import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FIXTURE_BOT_TOKEN, FIXTURE_CONNECTOR_ID, FIXTURE_WEBHOOK_SECRET, FIXTURE_WORKSPACE_ID, fixtureConnector } from "@/lib/integrations/telegram/fixtures";

const m = vi.hoisted(() => ({ requireAuth: vi.fn(), get: vi.fn(), chat: vi.fn(), send: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ data: { allowed: true, retry_after_seconds: 0 }, error: null }) }),
}));
vi.mock("@/lib/auth/guard", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/guard")>()), requireAuth: m.requireAuth }));
vi.mock("@/lib/integrations/telegram/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/telegram/store")>()),
  getTelegramConnector: m.get,
  findLinkedChatId: m.chat,
}));
vi.mock("@/lib/integrations/telegram/http", async (orig) => ({ ...(await orig<typeof import("@/lib/integrations/telegram/http")>()), sendMessage: m.send }));
vi.mock("@/lib/integrations/telegram/secrets", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/telegram/secrets")>()),
  readTelegramSecrets: () => ({ botToken: FIXTURE_BOT_TOKEN, webhookSecret: FIXTURE_WEBHOOK_SECRET }),
}));

import { POST } from "./route";

const admin = (over: Partial<Actor> = {}): Actor => ({ type: "user", id: "adm", label: "Ada", workspaceId: FIXTURE_WORKSPACE_ID, role: "admin", ...over });
const call = () =>
  POST(new NextRequest(`https://nopm.example.test/api/integrations/telegram/${FIXTURE_CONNECTOR_ID}/test`, { method: "POST" }), {
    params: Promise.resolve({ connectorId: FIXTURE_CONNECTOR_ID }),
  });

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.requireAuth.mockResolvedValue(admin());
  m.get.mockResolvedValue(fixtureConnector());
  m.chat.mockResolvedValue("555");
  m.send.mockResolvedValue({ ok: true, result: { message_id: 1 } });
});

describe("POST .../test", () => {
  it("sends one message to the calling admin's own linked chat only", async () => {
    const { data } = await (await call()).json();
    expect(data).toEqual({ ok: true });
    expect(m.chat).toHaveBeenCalledWith(FIXTURE_WORKSPACE_ID, FIXTURE_CONNECTOR_ID, "adm");
    expect(m.send).toHaveBeenCalledTimes(1);
    expect(m.send.mock.calls[0][1]).toMatchObject({ chatId: "555" });
  });

  it("422s when the admin has not linked Telegram, and sends nothing", async () => {
    m.chat.mockResolvedValue(null);
    expect((await call()).status).toBe(422);
    expect(m.send).not.toHaveBeenCalled();
  });

  it("reports a failed send as ok:false with the token removed", async () => {
    m.send.mockResolvedValue({ ok: false, error: `blocked ${FIXTURE_BOT_TOKEN}`, status: 403, retryable: false });
    const res = await call();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.ok).toBe(false);
    expect(JSON.stringify(body)).not.toContain(FIXTURE_BOT_TOKEN);
  });

  it("is admin-only and refuses a paused or missing connector", async () => {
    m.requireAuth.mockResolvedValue(admin({ role: "member" }));
    expect((await call()).status).toBe(403);
    m.requireAuth.mockResolvedValue(admin());
    m.get.mockResolvedValue(fixtureConnector({ status: "paused" }));
    expect((await call()).status).toBe(422);
    m.get.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
  });
});
