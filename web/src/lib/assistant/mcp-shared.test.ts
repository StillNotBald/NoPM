import { describe, it, expect, vi } from "vitest";
import { MCP_TOOLS } from "../../../mcp/tools.mjs";
import {
  callApi,
  toToolResult,
  toMcpTool,
  toolAnnotations,
  filterToolsByOpenApi,
  DESTRUCTIVE_TOOLS,
  MAX_RESULT_CHARS,
} from "../../../mcp/shared.mjs";

type Tool = (typeof MCP_TOOLS)[number];
const method = (t: Tool) => String(t.toRequest({}).method).toUpperCase();

describe("MCP tool annotations (M2)", () => {
  it("every GET tool is read-only and no other tool is", () => {
    for (const t of MCP_TOOLS as Tool[]) {
      const a = toolAnnotations(t);
      expect(a.readOnlyHint, t.name).toBe(method(t) === "GET");
      expect(a.openWorldHint, t.name).toBe(false);
      expect(typeof a.title).toBe("string");
    }
  });

  it("only the four decision/closing tools are destructive; deletion REQUESTS are not", () => {
    const destructive = (MCP_TOOLS as Tool[]).filter((t) => toolAnnotations(t).destructiveHint === true).map((t) => t.name);
    expect(destructive.sort()).toEqual([...DESTRUCTIVE_TOOLS].sort());
    for (const t of MCP_TOOLS as Tool[]) {
      if (t.name.startsWith("request_") || t.name === "withdraw_deletion_request") {
        expect(toolAnnotations(t).destructiveHint, t.name).toBe(false);
      }
    }
  });

  it("PATCH tools are idempotent, POST tools are not", () => {
    for (const t of MCP_TOOLS as Tool[]) {
      if (method(t) === "PATCH") expect(toolAnnotations(t).idempotentHint, t.name).toBe(true);
      if (method(t) === "POST") expect(toolAnnotations(t).idempotentHint, t.name).toBe(false);
    }
  });

  it("toMcpTool carries name, title, description, inputSchema and annotations", () => {
    const t = (MCP_TOOLS as Tool[])[0];
    const m = toMcpTool(t);
    expect(m).toMatchObject({ name: t.name, description: t.description, inputSchema: t.parameters });
    expect(m.annotations.title).toBe(m.title);
  });
});

describe("callApi (M5)", () => {
  const base = { baseUrl: "http://nopm.test/", token: "npm_t", path: "/api/x", method: "GET" };

  it("never throws on a network error and does not leak the raw error", async () => {
    const res = await callApi({ ...base, fetchImpl: vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1")) as never });
    expect(res).toMatchObject({ ok: false, status: 0 });
    expect(JSON.stringify(res)).not.toContain("10.0.0.1");
  });

  it("reports a timeout", async () => {
    const err = Object.assign(new Error("t"), { name: "TimeoutError" });
    const res = await callApi({ ...base, fetchImpl: vi.fn().mockRejectedValue(err) as never });
    expect(res.body.error).toBe("NoPM API timed out");
  });

  it("passes a timeout signal and the client headers", async () => {
    const f = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    await callApi({ ...base, requestId: "r1", fetchImpl: f as never });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("http://nopm.test/api/x");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toMatchObject({ Authorization: "Bearer npm_t", "X-NoPM-Client": "mcp", "X-Request-Id": "r1" });
  });

  it("keeps the first 300 chars of a non-JSON body", async () => {
    const f = vi.fn().mockResolvedValue(new Response("x".repeat(1000), { status: 502 }));
    const res = await callApi({ ...base, fetchImpl: f as never });
    expect(res.body.raw).toHaveLength(300);
    expect(res.status).toBe(502);
  });
});

describe("toToolResult (M5, M6)", () => {
  it("maps an HTTP error to isError with status, code, retry_after and fields", () => {
    const out = toToolResult({ ok: false, status: 429, body: { error: "slow down", code: "rate_limited", fields: [{ f: 1 }] }, retryAfterSeconds: 30 });
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0].text)).toEqual({ error: "slow down", status: 429, code: "rate_limited", retry_after_seconds: 30, fields: [{ f: 1 }] });
  });

  it("emits compact JSON and adds next_page only when more pages exist", () => {
    const more = toToolResult({ ok: true, status: 200, body: { data: [1], total: 50, page: 1, limit: 20 } });
    expect(more.content[0].text).not.toContain("\n");
    expect(JSON.parse(more.content[0].text).next_page).toBe(2);
    const last = toToolResult({ ok: true, status: 200, body: { data: [1], total: 5, page: 1, limit: 20 } });
    expect(JSON.parse(last.content[0].text).next_page).toBeUndefined();
    expect(last.isError).toBe(false);
  });

  it("truncates an oversized result with a hint", () => {
    const out = toToolResult({ ok: true, status: 200, body: { data: "y".repeat(MAX_RESULT_CHARS + 500) } });
    expect(out.content[0].text).toContain("[truncated");
    expect(out.content[0].text.length).toBeLessThan(MAX_RESULT_CHARS + 300);
  });
});

describe("filterToolsByOpenApi (M4)", () => {
  const tools = [
    { name: "a", toRequest: () => ({ path: "/api/projects", method: "GET" }) },
    { name: "b", toRequest: () => ({ path: "/api/risks/00000000-0000-0000-0000-000000000000", method: "GET" }) },
  ] as never[];
  const spec = (paths: Record<string, unknown>) => vi.fn().mockResolvedValue(new Response(JSON.stringify({ paths }), { status: 200 }));

  it("keeps only tools whose route the spec serves (ids match {param})", async () => {
    const kept = await filterToolsByOpenApi(tools, { baseUrl: "http://h", fetchImpl: spec({ "/api/projects": {}, "/api/other/{id}": {} }) as never });
    expect(kept.map((t: { name: string }) => t.name)).toEqual(["a"]);
    const both = await filterToolsByOpenApi(tools, { baseUrl: "http://h", fetchImpl: spec({ "/api/projects": {}, "/api/risks/{id}": {} }) as never });
    expect(both).toHaveLength(2);
  });

  it("fails open and warns when the spec cannot be read", async () => {
    const warn = vi.fn();
    const kept = await filterToolsByOpenApi(tools, { baseUrl: "http://h", fetchImpl: vi.fn().mockRejectedValue(new Error("x")) as never, warn });
    expect(kept).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
  });
});
