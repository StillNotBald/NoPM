/**
 * route() wrapper — R-84: a 401 (auth failure, before an Actor ever
 * resolves) still carries an X-Request-Id correlation header.
 *
 * requireAuth is mocked so the handler body is exercised without a live
 * Supabase session/token — this suite only asserts route()'s own
 * try/catch/stamp behavior, not auth verification itself (that's guard.ts's
 * own test surface).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { AuthError } from "@/lib/api/errors";

const requireAuthMock = vi.fn();

vi.mock("@/lib/auth/guard", () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}));

// checkRateLimit only runs after a successful requireAuth — unreachable on
// the 401-path tests below, but the last test here DOES resolve an actor
// (to test the handler-throws-after-auth path), so this stub still needs a
// working .rpc() to let checkRateLimit's own "allowed" branch pass through
// cleanly rather than throwing a TypeError on a bare {}.
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: { allowed: true, remaining: 999, retry_after_seconds: 0 }, error: null }),
  }),
}));

let route: typeof import("./handler").route;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ route } = await import("./handler"));
});

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/whatever", { headers });
}

describe("route() — 401 still carries X-Request-Id", () => {
  it("stamps X-Request-Id on the 401 response when requireAuth throws", async () => {
    requireAuthMock.mockRejectedValueOnce(new AuthError());
    const handler = route(async () => new Response(null, { status: 200 }));

    const res = await handler(request(), { params: Promise.resolve({}) });

    expect(res.status).toBe(401);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("echoes a caller-supplied safe X-Request-Id on the 401 response", async () => {
    requireAuthMock.mockRejectedValueOnce(new AuthError());
    const handler = route(async () => new Response(null, { status: 200 }));

    const res = await handler(request({ "x-request-id": "client-supplied-id-1" }), {
      params: Promise.resolve({}),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("X-Request-Id")).toBe("client-supplied-id-1");
  });

  it("generates a fresh id (not the auth error's own state) when none was supplied", async () => {
    requireAuthMock.mockRejectedValueOnce(new AuthError());
    const handler = route(async () => new Response(null, { status: 200 }));

    const res = await handler(request(), { params: Promise.resolve({}) });

    expect(res.headers.get("X-Request-Id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("does NOT stamp X-Request-Id for an { auth: false } route even if requireAuth would have thrown", async () => {
    // requireAuth is never called at all when auth:false (route() skips it),
    // so there is no actor and — by design — no correlation id to stamp
    // either; this route class stays out of scope for this fix.
    const handler = route(async () => new Response(null, { status: 200 }), { auth: false });

    const res = await handler(request(), { params: Promise.resolve({}) });

    expect(requireAuthMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBeNull();
  });

  it("still stamps X-Request-Id from the actor when the handler body itself throws after a successful auth", async () => {
    requireAuthMock.mockResolvedValueOnce({
      type: "user",
      id: "u1",
      label: "User",
      workspaceId: "ws1",
      requestId: "actor-req-id",
    });
    const handler = route(async () => {
      throw new AuthError("nope");
    });

    const res = await handler(request(), { params: Promise.resolve({}) });

    expect(res.headers.get("X-Request-Id")).toBe("actor-req-id");
  });
});

describe("route() — malformed ids are not a 500 (V1 R1-Low)", () => {
  const user = { type: "user", id: "u1", label: "User", workspaceId: "ws1", requestId: "req-1" };
  const uuidError = (v: string) => ({ code: "22P02", message: `invalid input syntax for type uuid: "${v}"` });

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    requireAuthMock.mockResolvedValue(user);
  });

  it("a non-UUID path id that reaches the database -> 404 not_found (not 500), request id still stamped", async () => {
    const handler = route(async () => {
      throw uuidError("not-a-uuid");
    });
    const res = await handler(request(), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found", code: "not_found" });
    expect(res.headers.get("X-Request-Id")).toBe("req-1");
  });

  it("the same error re-wrapped as new Error(message), as most routes do, maps the same way", async () => {
    const handler = route(async () => {
      throw new Error(uuidError("123").message);
    });
    const res = await handler(request(), { params: Promise.resolve({ id: "123" }) });
    expect(res.status).toBe(404);
  });

  it("a malformed filter value (not a path param) -> 422 validation_failed", async () => {
    const handler = route(async () => {
      throw uuidError("not-a-uuid");
    });
    const res = await handler(request(), { params: Promise.resolve({}) });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("validation_failed");
  });

  it("other database errors are still a sanitized 500", async () => {
    const handler = route(async () => {
      throw new Error("connection reset");
    });
    const res = await handler(request(), { params: Promise.resolve({}) });
    expect(res.status).toBe(500);
  });
});

describe("route() — Origin check on cookie-session mutations (V1 R1-Low)", () => {
  const user = { type: "user", id: "u1", label: "User", workspaceId: "ws1", requestId: "req-1" };
  const token = { type: "token", id: "t1", label: "agent", workspaceId: "ws1", scopes: ["*"], requestId: "req-2" };
  const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  const call = (handler: ReturnType<typeof route>, method: string, headers: Record<string, string> = {}) =>
    handler(new NextRequest("http://localhost/api/whatever", { method, headers }), { params: Promise.resolve({}) });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("session + %s + foreign Origin -> 403 bad_origin; the handler never runs", async (method) => {
    requireAuthMock.mockResolvedValueOnce(user);
    const body = vi.fn(ok);
    const res = await call(route(body), method, { origin: "https://evil.example.net" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("bad_origin");
    expect(res.headers.get("X-Request-Id")).toBe("req-1");
    expect(body).not.toHaveBeenCalled();
  });

  it("session + the app's own Origin, or no Origin at all -> allowed", async () => {
    for (const headers of [{ origin: "http://localhost" }, {}] as Record<string, string>[]) {
      requireAuthMock.mockResolvedValueOnce(user);
      expect((await call(route(ok), "PATCH", headers)).status).toBe(200);
    }
  });

  it("session + GET with a foreign Origin -> allowed (safe method)", async () => {
    requireAuthMock.mockResolvedValueOnce(user);
    expect((await call(route(ok), "GET", { origin: "https://evil.example.net" })).status).toBe(200);
  });

  it("a Bearer-token request is exempt, whatever the Origin", async () => {
    requireAuthMock.mockResolvedValueOnce(token);
    expect((await call(route(ok), "POST", { origin: "https://evil.example.net" })).status).toBe(200);
  });

  it("{ auth: false } routes (Lark webhook, relay, card, cron, invite accept) are not origin-checked", async () => {
    const res = await call(route(ok, { auth: false }), "POST", { origin: "https://open.larksuite.example" });
    expect(requireAuthMock).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("the check runs before the handler body and before the rate limiter", async () => {
    requireAuthMock.mockResolvedValueOnce(user);
    const res = await call(route(ok), "POST", { origin: "https://evil.example.net" });
    expect(res.status).toBe(403);
  });
});
