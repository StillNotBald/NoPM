import { describe, it, expect, vi } from "vitest";
import { makeApiCaller, trustedApiBase } from "./api";
import { assertAllowedScopes, ScopeNotAllowedError } from "./token";
import { fixtureConnector, profile } from "./fixtures";
import type { ApiRequest } from "./handlers";

const req = (over: Partial<ApiRequest> = {}): ApiRequest => ({
  connector: fixtureConnector(),
  profile: profile(),
  scopes: ["task:write"],
  method: "POST",
  path: "/api/projects/p1/tasks",
  body: { name: "x" },
  ...over,
});

describe("per-action token lifecycle", () => {
  it("mints one token, makes exactly one call with it, then revokes it", async () => {
    const order: string[] = [];
    const mint = vi.fn(async () => {
      order.push("mint");
      return { raw: "npm_raw_token", id: "tok-1" };
    });
    const revoke = vi.fn(async () => {
      order.push("revoke");
    });
    const fetchImpl = vi.fn(async () => {
      order.push("fetch");
      return new Response(JSON.stringify({ data: { id: "t9" } }), { status: 201 });
    }) as unknown as typeof fetch;
    const call = makeApiCaller({ origin: "https://nopm.example.test/", mint, revoke, fetchImpl });
    const res = await call(req());
    expect(res).toEqual({ status: 201, body: { data: { id: "t9" } } });
    expect(order).toEqual(["mint", "fetch", "revoke"]);
    expect(mint).toHaveBeenCalledWith(expect.anything(), expect.anything(), ["task:write"]);
    expect(revoke).toHaveBeenCalledWith(expect.anything(), expect.anything(), "tok-1", { audit: true });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://nopm.example.test/api/projects/p1/tasks");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer npm_raw_token");
    expect(JSON.parse(String(init.body))).toEqual({ name: "x" });
  });

  it("revokes the token even when the call fails, and reports a status instead of throwing", async () => {
    const revoke = vi.fn(async () => {});
    const call = makeApiCaller({
      origin: "https://nopm.example.test",
      mint: async () => ({ raw: "r", id: "tok-2" }),
      revoke,
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    });
    const res = await call(req());
    expect(res.status).toBe(503);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("when the token cannot be minted (or its mint cannot be audited) the action does not happen", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const call = makeApiCaller({
      origin: "https://nopm.example.test",
      mint: async () => {
        throw new Error("audit write failed");
      },
      revoke: async () => {},
      fetchImpl,
    });
    const res = await call(req());
    expect(res.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a GET carries no body", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const call = makeApiCaller({ origin: "https://nopm.example.test", mint: async () => ({ raw: "r", id: "t" }), revoke: async () => {}, fetchImpl });
    await call(req({ method: "GET", body: undefined, path: "/api/projects" }));
    expect(((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body).toBeUndefined();
  });

  it("a revoked or expired token comes back as the route's 401, untouched", async () => {
    const call = makeApiCaller({
      origin: "https://nopm.example.test",
      mint: async () => ({ raw: "r", id: "t" }),
      revoke: async () => {},
      fetchImpl: (async () => new Response(JSON.stringify({ error: "revoked" }), { status: 401 })) as unknown as typeof fetch,
    });
    expect((await call(req())).status).toBe(401);
  });
});

describe("scopes a chat token may carry", () => {
  it("allows the narrow read, write and request scopes", () => {
    for (const s of ["task:read", "project:read", "task:write", "issue:write", "risk:write", "task:delete:request"]) {
      expect(() => assertAllowedScopes([s])).not.toThrow();
    }
  });

  it("allows one approve scope, alone, only for the tapped request kinds", () => {
    expect(() => assertAllowedScopes(["task:delete:approve"])).not.toThrow();
    expect(() => assertAllowedScopes(["risk:delete:approve"])).not.toThrow();
    expect(() => assertAllowedScopes(["task:delete:approve", "task:write"])).toThrow(ScopeNotAllowedError);
    expect(() => assertAllowedScopes(["sprint:delete:approve"])).toThrow(ScopeNotAllowedError);
  });

  it("refuses wildcards, admin scopes, change-request approval and an empty list", () => {
    for (const bad of [["*"], ["task:*"], ["token:write"], ["change:approve"], ["rebaseline:approve"], ["admin:write"], []]) {
      expect(() => assertAllowedScopes(bad)).toThrow(ScopeNotAllowedError);
    }
  });

  it("the free-text/read paths use no approve scope: the handler never asks for one outside /4", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("./handlers.ts", import.meta.url), "utf8");
    const approveMentions = src.match(/delete:approve/g) ?? [];
    expect(approveMentions).toHaveLength(1); // the single template in tapDecision
  });
});

describe("the bearer only goes to the configured app URL (review round 1, N-11)", () => {
  it("trustedApiBase prefers NEXT_PUBLIC_APP_URL and ignores a request-derived origin", () => {
    expect(trustedApiBase("https://evil.example.test", { NEXT_PUBLIC_APP_URL: "https://nopm.example.test/" })).toBe("https://nopm.example.test");
    expect(trustedApiBase("https://evil.example.test", { VERCEL_PROJECT_PRODUCTION_URL: "nopm.example.test" })).toBe("https://nopm.example.test");
  });

  it("with nothing configured only a loopback origin is accepted (local development)", () => {
    expect(trustedApiBase("http://localhost:3000", {})).toBe("http://localhost:3000");
    expect(trustedApiBase("http://127.0.0.1:3000", {})).toBe("http://127.0.0.1:3000");
    expect(trustedApiBase("https://evil.example.test", {})).toBeNull();
    expect(trustedApiBase("http://localhost.evil.example.test", {})).toBeNull();
    expect(trustedApiBase(null, {})).toBeNull();
    expect(trustedApiBase("not a url", {})).toBeNull();
  });

  it("with no trusted base nothing is minted and nothing is sent", async () => {
    const mint = vi.fn(async () => ({ raw: "r", id: "t" }));
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const call = makeApiCaller({ origin: null, mint, revoke: async () => {}, fetchImpl });
    const res = await call(req());
    expect(res.status).toBe(503);
    expect(mint).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never follows a redirect with the bearer", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const call = makeApiCaller({ origin: "https://nopm.example.test", mint: async () => ({ raw: "r", id: "t" }), revoke: async () => {}, fetchImpl });
    await call(req());
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].redirect).toBe("error");
  });

  it("a read-only call revokes without a second audit row; a write audits its revoke", async () => {
    const revoke = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const call = makeApiCaller({ origin: "https://nopm.example.test", mint: async () => ({ raw: "r", id: "t" }), revoke, fetchImpl });
    await call({ ...req(), method: "GET", scopes: ["task:read"] });
    expect(revoke).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "t", { audit: false });
    await call(req());
    expect(revoke).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "t", { audit: true });
  });
});
