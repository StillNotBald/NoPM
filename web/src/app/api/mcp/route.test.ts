/**
 * /api/mcp — the unauthenticated 401 uses the same { error, code } contract as
 * every REST route and carries the Bearer challenge (audit L-07). Only the
 * pre-auth branch is exercised here: with a Bearer header the route forwards
 * to the REST API, which owns scope / audit enforcement.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { GET, POST, DELETE } from "./route";

const req = (method: string, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/mcp", { method, headers, body: method === "POST" ? "{}" : undefined });

describe("/api/mcp without a Bearer token", () => {
  for (const [method, handler] of [["GET", GET], ["POST", POST], ["DELETE", DELETE]] as const) {
    it(`${method} → 401 { error, code } + WWW-Authenticate`, async () => {
      const res = await handler(req(method));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="nopm"');
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      const body = await res.json();
      expect(body.code).toBe("unauthorized");
      expect(body.error).toMatch(/Missing Bearer token/);
      expect(Object.keys(body).sort()).toEqual(["code", "error"]);
    });
  }

  it("treats a non-Bearer Authorization scheme as missing", async () => {
    const res = await POST(req("POST", { authorization: "Basic abc" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="nopm"');
  });

  it("stamps a correlation id, echoing a safe caller-supplied one", async () => {
    const generated = await GET(req("GET"));
    expect(generated.headers.get("x-request-id")).toBeTruthy();
    const echoed = await GET(req("GET", { "x-request-id": "client-id-7" }));
    expect(echoed.headers.get("x-request-id")).toBe("client-id-7");
  });
});

describe("/api/mcp internal origin", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const authed = (url: string) =>
    new Request(url, {
      method: "POST",
      headers: {
        authorization: "Bearer npm_secret",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_projects", arguments: {} },
      }),
    });

  it("production with no configured app URL: 503 and the token is never forwarded", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("VERCEL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(authed("http://evil.example/api/mcp"));

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("misconfigured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards to the configured app URL, not the Host-derived origin", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://nopm.example.com");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await POST(authed("http://evil.example/api/mcp"));

    expect(fetchMock).toHaveBeenCalled();
    const target = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(target.startsWith("https://nopm.example.com/")).toBe(true);
    expect(target).not.toContain("evil.example");
  });
});

describe("/api/mcp governance tools (parity with the stdio server)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const rpc = (method: string, params: unknown) =>
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer npm_caller",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

  it("tools/list includes every governance tool", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://nopm.example.com");
    const { MCP_GOVERNANCE_TOOLS } = await import("../../../../mcp/tools.mjs");
    const res = await POST(rpc("tools/list", {}));
    const body = await res.json();
    const names = body.result.tools.map((t: { name: string }) => t.name);
    for (const t of MCP_GOVERNANCE_TOOLS as Array<{ name: string }>) expect(names).toContain(t.name);
  });

  it("forwards a governance tool call with the caller token", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://nopm.example.com");
    const { MCP_GOVERNANCE_TOOLS } = await import("../../../../mcp/tools.mjs");
    type P = { type?: string; enum?: unknown[] };
    const tool = (MCP_GOVERNANCE_TOOLS as unknown as Array<{ name: string; parameters: { required?: string[]; properties: Record<string, P> } }>)[0];
    const args: Record<string, unknown> = {};
    for (const k of tool.parameters.required ?? []) {
      const p = tool.parameters.properties[k];
      args[k] = p.enum ? p.enum[0] : p.type === "number" || p.type === "integer" ? 1 : p.type === "boolean" ? true : "00000000-0000-4000-8000-000000000001";
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await POST(rpc("tools/call", { name: tool.name, arguments: args }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer npm_caller");
  });
});
