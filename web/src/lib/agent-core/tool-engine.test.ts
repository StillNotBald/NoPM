import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/assistant/providers/index", () => ({ chat: vi.fn(), chatStream: vi.fn() }));

import { executeToolCall } from "./tool-engine";

const UUID = "11111111-1111-4111-8111-111111111111";
const ctx = { origin: "http://nopm.test", token: "npm_secret", requestId: "req-1", channel: "assistant" };

afterEach(() => vi.unstubAllGlobals());

describe("executeToolCall (shared engine, A13)", () => {
  it("answers an unknown tool with a failed action and tool message, never a throw", async () => {
    const out = await executeToolCall({ id: "c1", name: "no_such_tool", args: {} }, ctx);
    expect(out.action).toMatchObject({ tool: "no_such_tool", ok: false, summary: "Unknown tool: no_such_tool" });
    expect(out.message).toMatchObject({ role: "tool", tool_call_id: "c1" });
  });

  it("refuses path-unsafe arguments before any fetch", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const out = await executeToolCall({ id: "c2", name: "get_project", args: { project_id: "../x" } }, ctx);
    expect(out.action.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("calls the API with the bearer token, client label and request id", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { id: UUID } }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const out = await executeToolCall({ id: "c3", name: "get_project", args: { project_id: UUID } }, ctx);
    expect(out.action.ok).toBe(true);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(`http://nopm.test/api/projects/${UUID}`);
    expect(init.headers).toMatchObject({ Authorization: "Bearer npm_secret", "X-NoPM-Client": "assistant", "X-Request-Id": "req-1" });
  });

  it("turns a network failure into a failed action", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    const out = await executeToolCall({ id: "c4", name: "get_project", args: { project_id: UUID } }, ctx);
    expect(out.action.ok).toBe(false);
  });
});
