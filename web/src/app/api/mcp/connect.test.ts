import { describe, it, expect, vi, afterEach } from "vitest";
import { POST } from "./route";

describe("/api/mcp token check on connect (M7) and annotations (M2)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const rpc = (method: string, params: unknown = {}) =>
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer npm_revoked",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

  it("a rejected token fails tools/list and initialize with 401, after one /api/me check", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://nopm.example.com");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    for (const m of ["tools/list", "initialize"]) {
      const res = await POST(rpc(m));
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBeTruthy();
    }
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("https://nopm.example.com/api/me");
  });

  it("a network failure on the check does not block the connection", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://nopm.example.com");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    const res = await POST(rpc("tools/list"));
    expect(res.status).toBe(200);
  });

  it("tools/call does not pay for the extra /api/me fetch", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://nopm.example.com");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await POST(rpc("tools/call", { name: "list_projects", arguments: {} }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain("/api/projects");
  });

  it("tools/list carries annotations; reads are readOnly", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://nopm.example.com");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 })));
    const body = await (await POST(rpc("tools/list"))).json();
    const tools = body.result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean; openWorldHint: boolean } }>;
    expect(tools.every((t) => t.annotations && t.annotations.openWorldHint === false)).toBe(true);
    expect(tools.find((t) => t.name === "list_projects")?.annotations.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "create_task")?.annotations.readOnlyHint).toBe(false);
  });

  it("an API failure on a tool call is an isError result carrying the status", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://nopm.example.com");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Forbidden", code: "forbidden" }), { status: 403 })));
    const body = await (await POST(rpc("tools/call", { name: "list_projects", arguments: {} }))).json();
    expect(body.result.isError).toBe(true);
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({ error: "Forbidden", status: 403, code: "forbidden" });
  });
});
