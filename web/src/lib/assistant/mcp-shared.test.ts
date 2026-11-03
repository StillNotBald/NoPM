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
import { specForTesting as realSpec } from "@/app/api/openapi.json/route";
import { MODULE_IDS, filterOpenApi, filterTools } from "@/lib/modules";

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

  it("truncates an oversized non-list result to valid JSON with truncated:true", () => {
    const out = toToolResult({ ok: true, status: 200, body: { data: "y".repeat(MAX_RESULT_CHARS + 500) } });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.truncated).toBe(true);
    expect(out.content[0].text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  });

  it("truncates an oversized list by dropping items, still valid JSON (review N1)", () => {
    const data = Array.from({ length: 400 }, (_, i) => ({ id: i, note: "z".repeat(500) }));
    const out = toToolResult({ ok: true, status: 200, body: { data, total: 400, page: 1, limit: 400 } });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.truncated).toBe(true);
    expect(parsed.total).toBe(400);
    expect(parsed.data.length).toBeGreaterThan(0);
    expect(parsed.data.length).toBeLessThan(400);
    expect(parsed.returned).toBe(parsed.data.length);
    expect(out.content[0].text.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
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

  it("matches paths relative to the server base path (NoPM's spec: server .../api, paths /projects)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ servers: [{ url: "https://h/api" }], paths: { "/projects": {} } }), { status: 200 }),
    );
    const kept = await filterToolsByOpenApi(tools, { baseUrl: "http://h", fetchImpl: fetchImpl as never });
    expect(kept.map((t: { name: string }) => t.name)).toEqual(["a"]);
  });

  const served = (body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  const names = (list: readonly { name: string }[]) => list.map((t) => t.name);

  it("keeps every MCP tool against the real spec with all modules on, without falling open", async () => {
    const warn = vi.fn();
    const kept = await filterToolsByOpenApi(MCP_TOOLS as never[], { baseUrl: "http://h", fetchImpl: served(realSpec) as never, warn });
    expect(names(kept)).toEqual(names(MCP_TOOLS as Tool[]));
    expect(warn).not.toHaveBeenCalled();
  });

  it("matches the remote route when a module is switched off (real spec, sprints off)", async () => {
    const enabled = new Set(MODULE_IDS.filter((id) => id !== "sprints"));
    const warn = vi.fn();
    const kept = await filterToolsByOpenApi(MCP_TOOLS as never[], {
      baseUrl: "http://h",
      fetchImpl: served(filterOpenApi(realSpec, enabled)) as never,
      warn,
    });
    expect(names(kept)).toEqual(names(filterTools(MCP_TOOLS as Tool[], enabled)));
    expect(names(kept)).not.toContain("list_sprints");
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls open with a warning when the spec loads but nothing matches", async () => {
    const warn = vi.fn();
    const kept = await filterToolsByOpenApi(tools, { baseUrl: "http://h", fetchImpl: served({ servers: [{ url: "https://h/v9" }], paths: { "/elsewhere": {} } }) as never, warn });
    expect(kept).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("did not match"));
  });

  it("falls open when the always-served list_projects is dropped", async () => {
    const warn = vi.fn();
    const two = [
      { name: "list_projects", toRequest: () => ({ path: "/api/projects", method: "GET" }) },
      { name: "list_risks", toRequest: () => ({ path: "/api/risks", method: "GET" }) },
    ] as never[];
    const kept = await filterToolsByOpenApi(two, { baseUrl: "http://h", fetchImpl: served({ paths: { "/api/risks": {} } }) as never, warn });
    expect(kept).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
  });

  it("reads the base path from a server URL with variables", async () => {
    for (const url of ["https://{host}/api", "{scheme}://h/api"]) {
      const kept = await filterToolsByOpenApi(tools, { baseUrl: "http://h", fetchImpl: served({ servers: [{ url }], paths: { "/projects": {} } }) as never });
      expect(names(kept), url).toEqual(["a"]);
    }
  });

  it("fails open and warns when the spec cannot be read", async () => {
    const warn = vi.fn();
    const kept = await filterToolsByOpenApi(tools, { baseUrl: "http://h", fetchImpl: vi.fn().mockRejectedValue(new Error("x")) as never, warn });
    expect(kept).toHaveLength(2);
    expect(warn).toHaveBeenCalled();
  });
});
