import { describe, it, expect, vi, afterEach } from "vitest";
import { FIXTURE_BOT_TOKEN, FIXTURE_CONNECTOR_ID, FIXTURE_WEBHOOK_SECRET, fixtureConnector } from "./fixtures";

vi.mock("./secrets", async (orig) => {
  const real = await orig<typeof import("./secrets")>();
  return { ...real, readTelegramSecrets: () => ({ botToken: FIXTURE_BOT_TOKEN, webhookSecret: FIXTURE_WEBHOOK_SECRET }) };
});

import { registerChatMenu, registerTelegram } from "./setup";

afterEach(() => vi.unstubAllGlobals());

function stub(handler: (method: string, body: Record<string, unknown>) => unknown) {
  const f = vi.fn(async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const out = handler(method, JSON.parse(String(init.body)));
    return out instanceof Response ? out : new Response(JSON.stringify({ ok: true, result: out }), { status: 200 });
  });
  vi.stubGlobal("fetch", f);
  return f;
}
const methods = (f: ReturnType<typeof stub>) => f.mock.calls.map(([u]) => String(u).split("/").pop());

describe("registerTelegram", () => {
  it("checks the token, then calls setWebhook with the connector secret and setMyCommands for the default scope", async () => {
    const f = stub((m) => (m === "getMe" ? { id: 1, username: "example_bot", is_bot: true } : true));
    const res = await registerTelegram(fixtureConnector(), "https://nopm.example.test/");
    expect(res).toEqual({ ok: true, botUsername: "example_bot" });
    expect(methods(f)).toEqual(["getMe", "setWebhook", "setMyCommands"]);
    const hook = JSON.parse(String(f.mock.calls[1][1].body));
    expect(hook).toMatchObject({ url: `https://nopm.example.test/api/integrations/telegram/${FIXTURE_CONNECTOR_ID}/webhook`, secret_token: FIXTURE_WEBHOOK_SECRET });
    const menu = JSON.parse(String(f.mock.calls[2][1].body));
    expect(menu.scope).toEqual({ type: "default" });
    expect(menu.commands.map((c: { command: string }) => c.command)).toEqual(["1", "2", "3", "5", "6", "0"]); // the member menu
  });

  it("a refused token stops before any webhook is set", async () => {
    const f = stub(() => new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), { status: 401 }));
    const res = await registerTelegram(fixtureConnector(), "https://nopm.example.test");
    expect(res).toMatchObject({ ok: false, step: "token" });
    expect(methods(f)).toEqual(["getMe"]);
  });

  it("a refused webhook (for example a non-HTTPS URL) is reported with its step and no token", async () => {
    stub((m) => (m === "getMe" ? { id: 1, is_bot: true } : new Response(JSON.stringify({ ok: false, error_code: 400, description: `Bad Request: HTTPS url must be provided ${FIXTURE_BOT_TOKEN}` }), { status: 400 })));
    const res = await registerTelegram(fixtureConnector(), "http://localhost:3000");
    expect(res).toMatchObject({ ok: false, step: "webhook" });
    expect(JSON.stringify(res)).not.toContain(FIXTURE_BOT_TOKEN);
  });
});

describe("registerChatMenu", () => {
  it("gives a manager a per-chat command scope with the approvals item", async () => {
    const f = stub(() => true);
    await registerChatMenu(fixtureConnector(), "1001", "manager");
    const body = JSON.parse(String(f.mock.calls[0][1].body));
    expect(methods(f)).toEqual(["setMyCommands"]);
    expect(body.scope).toEqual({ type: "chat", chat_id: 1001 });
    expect(body.commands.map((c: { command: string }) => c.command)).toContain("4");
  });

  it("a member's chat falls back to the default scope (any old per-chat scope is deleted)", async () => {
    const f = stub(() => true);
    await registerChatMenu(fixtureConnector(), "1001", "member");
    expect(methods(f)).toEqual(["deleteMyCommands"]);
  });
});
