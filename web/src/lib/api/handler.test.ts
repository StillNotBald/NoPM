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
