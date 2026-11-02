import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@/lib/assistant/providers/index", () => ({ chat: vi.fn(), chatStream: vi.fn() }));

import { executeToolCall, runToolRounds, boundToolResult, genericSummary, summarize, buildHref, MAX_TOOL_RESULT_CHARS } from "./tool-engine";
import { chat } from "@/lib/assistant/providers/index";
import { TOOLS } from "@/lib/assistant/tools";

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

describe("tool result bounding (A10)", () => {
  it("passes a small result through unchanged", () => {
    expect(boundToolResult({ data: [1, 2] })).toBe('{"data":[1,2]}');
  });

  it("drops trailing rows of a long list, keeps total and says so", () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i, note: "x".repeat(50) }));
    const out = JSON.parse(boundToolResult({ data: rows, total: 2000, page: 1, limit: 100 }));
    expect(out.truncated).toBe(true);
    expect(out.total).toBe(2000);
    expect(out.data.length).toBeLessThan(2000);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
    expect(out.hint).toMatch(/fields=/);
  });

  it("replaces one huge non-list value with a notice, still valid JSON", () => {
    const out = JSON.parse(boundToolResult({ data: { body: "y".repeat(50_000) } }));
    expect(out.truncated).toBe(true);
    expect(out.original_chars).toBeGreaterThan(50_000);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  it("never echoes the raw network error (it can carry the internal origin)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED http://internal.host:3000")));
    const out = await executeToolCall({ id: "c9", name: "get_project", args: { project_id: UUID } }, ctx);
    expect(out.action.summary).not.toMatch(/internal\.host/);
    expect(String(out.message.content)).not.toMatch(/internal\.host/);
    expect(String(out.message.content)).toMatch(/network error calling NoPM/);
  });
});

describe("action summaries (A11)", () => {
  it("names the change instead of a bare completed", () => {
    expect(summarize("update_task", { task_id: UUID, status_type: "started", priority: "high" }, { data: { name: "Ship it" } }, true)).toBe(
      'Updated task "Ship it" (status_type, priority)',
    );
    expect(summarize("request_risk_deletion", {}, { data: {} }, true)).toBe("Requested deletion of risk (pending approval)");
    expect(summarize("create_decision", {}, { data: { title: "Use A" } }, true)).toBe('Created decision "Use A"');
    expect(summarize("get_evm", {}, { data: {} }, true)).toBe("Retrieved evm");
    expect(summarize("close_sprint", {}, { data: {} }, true)).toBe("Close sprint done");
    expect(genericSummary("list_sprints", {}, { total: 3 }, null)).toBe("Listed 3 sprints");
  });

  it("links an update to the page it changed", () => {
    expect(buildHref("update_task", { project_id: UUID }, { data: { id: "t1" } })).toBe(`/projects/${UUID}/tasks`);
    expect(buildHref("update_project", { project_id: UUID }, { data: { id: UUID } })).toBe(`/projects/${UUID}`);
  });

  it("records the entity id of a successful write", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { id: UUID, name: "P" } }), { status: 201 })));
    const out = await executeToolCall({ id: "c8", name: "create_project", args: { name: "P" } }, ctx);
    expect(out.action.entityId).toBe(UUID);
  });
});

describe("runToolRounds runs only the tools it offered", () => {
  it("refuses a tool the model names but was not offered, without any fetch", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const chatMock = vi.mocked(chat);
    chatMock.mockReset();
    chatMock
      .mockResolvedValueOnce({ text: null, toolCalls: [{ id: "w1", name: "create_task", args: { project_id: UUID, title: "x" } }] } as never)
      .mockResolvedValueOnce({ text: "done", toolCalls: [] } as never);
    const readOnly = TOOLS.filter((t) => t.definition.name === "get_project").map((t) => t.definition);
    const actions: Parameters<typeof runToolRounds>[0]["actions"] = [];
    const out = await runToolRounds({ provider: "anthropic", apiKey: "k", model: "m", system: "s", messages: [{ role: "user", content: "hi" }], tools: readOnly, ctx, actions } as never);
    expect(out).toEqual({ kind: "text", text: "done" });
    expect(f).not.toHaveBeenCalled();
    expect(actions[0]).toMatchObject({ tool: "create_task", ok: false, summary: "Tool not available here: create_task" });
  });
});
