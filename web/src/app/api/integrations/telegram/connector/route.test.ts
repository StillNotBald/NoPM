/**
 * Telegram connector management routes (admin session only). Telegram, the
 * store and the audited writer are mocked: this asserts the route rules - who may
 * call, the token is checked before anything is stored, the token never comes
 * back, one live connector per workspace, disconnect erases and unlinks.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Actor } from "@/lib/auth/guard";
import { FIXTURE_BOT_TOKEN, FIXTURE_CONNECTOR_ID, FIXTURE_WORKSPACE_ID, fixtureConnector } from "@/lib/integrations/telegram/fixtures";

const m = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  live: vi.fn(),
  testTelegram: vi.fn(),
  registerTelegram: vi.fn(),
  removeWebhook: vi.fn(),
  auditedInsert: vi.fn(),
  auditedUpdate: vi.fn(),
  rpc: vi.fn(),
  cleanup: vi.fn(),
}));

vi.mock("@/lib/auth/guard", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/guard")>()), requireAuth: m.requireAuth }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: m.rpc }) }));
vi.mock("@/lib/audit/audited-write", () => ({ auditedInsert: m.auditedInsert, auditedUpdate: m.auditedUpdate }));
vi.mock("@/lib/integrations/telegram/setup", () => ({ testTelegram: m.testTelegram, registerTelegram: m.registerTelegram, removeWebhook: m.removeWebhook }));
vi.mock("@/lib/integrations/telegram/secrets", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/telegram/secrets")>()),
  encryptTelegramSecrets: () => "enc-blob",
}));
vi.mock("@/lib/integrations/telegram/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/telegram/store")>()),
  getLiveTelegramConnector: m.live,
  disconnectCleanup: m.cleanup,
}));

import { DELETE, GET, PATCH, POST } from "./route";

const admin = (over: Partial<Actor> = {}): Actor => ({ type: "user", id: "adm", label: "Ada", workspaceId: FIXTURE_WORKSPACE_ID, role: "admin", ...over });
const req = (method: string, body?: unknown) =>
  new NextRequest("https://nopm.example.test/api/integrations/telegram/connector", { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });

beforeEach(() => {
  Object.values(m).forEach((f) => f.mockReset());
  m.requireAuth.mockResolvedValue(admin());
  m.live.mockResolvedValue(null);
  m.testTelegram.mockResolvedValue({ ok: true, username: "example_bot" });
  m.registerTelegram.mockResolvedValue({ ok: true, botUsername: "example_bot" });
  m.auditedInsert.mockImplementation(async (a: { patch: Record<string, unknown> }) => ({ before: null, after: { ...fixtureConnector(), ...a.patch, secret_enc: undefined } }));
  m.auditedUpdate.mockImplementation(async (a: { patch: Record<string, unknown> }) => ({ before: null, after: { ...a.patch } }));
  m.rpc.mockImplementation(async (name: string) => (name === "nopm_rate_check" ? { data: { allowed: true, retry_after_seconds: 0 }, error: null } : { error: null }));
  m.cleanup.mockResolvedValue(true);
});

describe("GET", () => {
  it("an admin sees the connector view with the webhook URL, never the token", async () => {
    m.live.mockResolvedValue(fixtureConnector());
    const body = await (await GET(req("GET"), { params: Promise.resolve({}) })).json();
    expect(body.data.can_manage).toBe(true);
    expect(body.data.connector.webhook_url).toContain(`/api/integrations/telegram/${FIXTURE_CONNECTOR_ID}/webhook`);
    expect(JSON.stringify(body)).not.toMatch(/secret_enc|botToken|webhookSecret|123456:/);
  });

  it("a member sees only name and status", async () => {
    m.requireAuth.mockResolvedValue(admin({ role: "member" }));
    m.live.mockResolvedValue(fixtureConnector());
    const body = await (await GET(req("GET"), { params: Promise.resolve({}) })).json();
    expect(body.data.connector).toEqual({ name: "Telegram", status: "active" });
    expect(body.data.can_manage).toBe(false);
  });
});

describe("POST", () => {
  it("checks the token with Telegram, stores it encrypted with ONE audited insert, registers, and never echoes the token", async () => {
    const res = await POST(req("POST", { token: FIXTURE_BOT_TOKEN }), { params: Promise.resolve({}) });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(m.testTelegram).toHaveBeenCalledWith(FIXTURE_BOT_TOKEN);
    expect(m.auditedInsert).toHaveBeenCalledTimes(1);
    const arg = m.auditedInsert.mock.calls[0][0];
    expect(arg.table).toBe("integration_connectors");
    expect(arg.action).toBe("integration.connector.create");
    expect(arg.patch).toMatchObject({ kind: "telegram", status: "active", secret_enc: "enc-blob" });
    expect(arg.omitColumns).toContain("secret_enc");
    expect(JSON.stringify(arg.auditAfter)).not.toContain(FIXTURE_BOT_TOKEN);
    expect(JSON.stringify(body)).not.toContain(FIXTURE_BOT_TOKEN);
    expect(body.data.registration).toEqual({ ok: true });
  });

  it("a token Telegram refuses stores nothing", async () => {
    m.testTelegram.mockResolvedValue({ ok: false, error: "Unauthorized" });
    const res = await POST(req("POST", { token: FIXTURE_BOT_TOKEN }), { params: Promise.resolve({}) });
    expect(res.status).toBe(422);
    expect(m.auditedInsert).not.toHaveBeenCalled();
  });

  it("a webhook that Telegram refuses is reported with its step; the connector exists so it can be retried", async () => {
    m.registerTelegram.mockResolvedValue({ ok: false, step: "webhook", error: `HTTPS url must be provided ${FIXTURE_BOT_TOKEN}` });
    const body = await (await POST(req("POST", { token: FIXTURE_BOT_TOKEN }), { params: Promise.resolve({}) })).json();
    expect(body.data.registration.ok).toBe(false);
    expect(body.data.registration.step).toBe("webhook");
    expect(JSON.stringify(body)).not.toContain(FIXTURE_BOT_TOKEN);
  });

  it("422s a malformed token and a second connector; 403s a non-admin and a token caller", async () => {
    expect((await POST(req("POST", { token: "nope" }), { params: Promise.resolve({}) })).status).toBe(422);
    m.live.mockResolvedValue(fixtureConnector());
    expect((await POST(req("POST", { token: FIXTURE_BOT_TOKEN }), { params: Promise.resolve({}) })).status).toBe(422);
    m.requireAuth.mockResolvedValue(admin({ role: "manager" }));
    expect((await POST(req("POST", { token: FIXTURE_BOT_TOKEN }), { params: Promise.resolve({}) })).status).toBe(403);
    m.requireAuth.mockResolvedValue(admin({ type: "token", role: undefined, scopes: ["*"] }));
    expect((await POST(req("POST", { token: FIXTURE_BOT_TOKEN }), { params: Promise.resolve({}) })).status).toBe(403);
    expect(m.auditedInsert).not.toHaveBeenCalled();
  });
});

describe("PATCH", () => {
  it("turns the bot off with one audited update", async () => {
    m.live.mockResolvedValue(fixtureConnector());
    const res = await PATCH(req("PATCH", { status: "paused" }), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(m.auditedUpdate).toHaveBeenCalledTimes(1);
    expect(m.auditedUpdate.mock.calls[0][0].patch).toEqual({ status: "paused" });
  });

  it("is atomic: when the audit write fails the update fails too", async () => {
    m.live.mockResolvedValue(fixtureConnector());
    m.auditedUpdate.mockRejectedValue(new Error("audit failed"));
    expect((await PATCH(req("PATCH", { status: "paused" }), { params: Promise.resolve({}) })).status).toBeGreaterThanOrEqual(500);
  });

  it("rejects anything but active or paused", async () => {
    m.live.mockResolvedValue(fixtureConnector());
    expect((await PATCH(req("PATCH", { status: "revoked" }), { params: Promise.resolve({}) })).status).toBe(422);
  });
});

describe("DELETE (disconnect)", () => {
  it("deletes the webhook, revokes in one transaction (one audit row), then erases the token and pending rows", async () => {
    m.live.mockResolvedValue(fixtureConnector());
    const res = await DELETE(req("DELETE"), { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    expect(m.removeWebhook).toHaveBeenCalledTimes(1);
    const revokes = m.rpc.mock.calls.filter((c) => c[0] === "nopm_revoke_connector");
    expect(revokes).toHaveLength(1);
    expect(m.cleanup).toHaveBeenCalledWith(FIXTURE_WORKSPACE_ID, FIXTURE_CONNECTOR_ID);
    const body = await res.json();
    expect(body.data).toMatchObject({ status: "revoked", has_bot_token: false, token_erased: true });
  });

  it("is atomic: when the audited revoke fails the disconnect fails and nothing else is undone", async () => {
    m.live.mockResolvedValue(fixtureConnector());
    m.rpc.mockImplementation(async () => ({ error: { message: "audit insert failed" } }));
    const res = await DELETE(req("DELETE"), { params: Promise.resolve({}) });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(m.removeWebhook).not.toHaveBeenCalled();
    expect(m.cleanup).not.toHaveBeenCalled();
  });

  it("404s when there is nothing to disconnect", async () => {
    expect((await DELETE(req("DELETE"), { params: Promise.resolve({}) })).status).toBe(404);
    expect(m.rpc.mock.calls.filter((c) => c[0] === "nopm_revoke_connector")).toHaveLength(0);
  });
});
