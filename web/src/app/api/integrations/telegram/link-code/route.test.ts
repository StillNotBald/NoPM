import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FIXTURE_CONNECTOR_ID, FIXTURE_WORKSPACE_ID, fixtureConnector } from "@/lib/integrations/telegram/fixtures";

const m = vi.hoisted(() => ({ requireAuth: vi.fn(), live: vi.fn(), mint: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: async () => ({ data: { allowed: true, retry_after_seconds: 0 }, error: null }) }),
}));
vi.mock("@/lib/auth/guard", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/guard")>()), requireAuth: m.requireAuth }));
vi.mock("@/lib/integrations/telegram/store", async (orig) => ({ ...(await orig<typeof import("@/lib/integrations/telegram/store")>()), getLiveTelegramConnector: m.live }));
vi.mock("@/lib/integrations/identity", async (orig) => ({ ...(await orig<typeof import("@/lib/integrations/identity")>()), mintLinkCode: m.mint }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: m.audit }));

import { POST } from "./route";

const member = (over: Partial<Actor> = {}): Actor => ({ type: "user", id: "mem", label: "Pat", workspaceId: FIXTURE_WORKSPACE_ID, role: "member", ...over });
const call = () => POST(new NextRequest("https://nopm.example.test/api/integrations/telegram/link-code", { method: "POST" }), { params: Promise.resolve({}) });

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.requireAuth.mockResolvedValue(member());
  m.live.mockResolvedValue(fixtureConnector());
  m.mint.mockResolvedValue({ code: "NPL-ABCD-2345", expiresAt: "2026-11-03T00:10:00.000Z" });
});

describe("POST /integrations/telegram/link-code", () => {
  it("mints one code for the signed-in member and returns the t.me deep link", async () => {
    const res = await call();
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(m.mint).toHaveBeenCalledWith({ workspaceId: FIXTURE_WORKSPACE_ID, profileId: "mem", connectorId: FIXTURE_CONNECTOR_ID });
    expect(data).toMatchObject({
      code: "NPL-ABCD-2345",
      expires_at: "2026-11-03T00:10:00.000Z",
      bot_username: "example_bot",
      deep_link: "https://t.me/example_bot?start=NPL-ABCD-2345",
    });
  });

  it("audits that a code was minted, never the code", async () => {
    await call();
    expect(m.audit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(m.audit.mock.calls[0][0])).not.toContain("ABCD");
  });

  it("422s when no bot is connected or it is paused, and mints nothing", async () => {
    m.live.mockResolvedValue(null);
    expect((await call()).status).toBe(422);
    m.live.mockResolvedValue(fixtureConnector({ status: "paused" }));
    expect((await call()).status).toBe(422);
    expect(m.mint).not.toHaveBeenCalled();
  });

  it("refuses a token caller", async () => {
    m.requireAuth.mockResolvedValue(member({ type: "token" }));
    expect((await call()).status).toBe(403);
    expect(m.mint).not.toHaveBeenCalled();
  });
});
