/**
 * /api/mcp — the unauthenticated 401 uses the same { error, code } contract as
 * every REST route and carries the Bearer challenge (audit L-07). Only the
 * pre-auth branch is exercised here: with a Bearer header the route forwards
 * to the REST API, which owns scope / audit enforcement.
 */
import { describe, it, expect } from "vitest";
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
