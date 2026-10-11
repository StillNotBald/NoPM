import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScopeError, AuthError } from "@/lib/api/errors";

// ---------------------------------------------------------------------------
// R-91 MFA gate mocks (requireAuth / assertMfaSatisfied / isMfaChallengeExempt)
//
// requireScope's tests below are pure and never touch these; they're only
// exercised by the "requireAuth — R-91 MFA gate" suite further down.
// ---------------------------------------------------------------------------
const { getMfaEnrollmentStatusMock, verifyMfaCookieMock } = vi.hoisted(() => ({
  getMfaEnrollmentStatusMock: vi.fn(),
  verifyMfaCookieMock: vi.fn(),
}));
vi.mock("@/lib/auth/mfa", () => ({
  MFA_COOKIE_NAME: "nopm_mfa",
  getMfaEnrollmentStatus: getMfaEnrollmentStatusMock,
  verifyMfaCookie: verifyMfaCookieMock,
}));

const { cookiesGetMock } = vi.hoisted(() => ({ cookiesGetMock: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: cookiesGetMock }),
}));

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

const { createAdminClientMock } = vi.hoisted(() => ({ createAdminClientMock: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: (...args: unknown[]) => createAdminClientMock(...args),
}));

import { requireAuth, requireScope, type Actor } from "./guard";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function tokenActor(scopes: string[]): Actor {
  return {
    type: "token",
    id: "tok_01",
    label: "ci-agent",
    workspaceId: "ws_01",
    scopes,
  };
}

function userActor(role: string): Actor {
  return {
    type: "user",
    id: "usr_01",
    label: "alice",
    workspaceId: "ws_01",
    role,
  };
}

// ---------------------------------------------------------------------------
// Token actors
// ---------------------------------------------------------------------------
describe("requireScope — token actor", () => {
  it("passes when token holds the exact required scope", () => {
    expect(() => requireScope(tokenActor(["task:read"]), "task:read")).not.toThrow();
  });

  it("passes when token holds resource:* covering the required scope", () => {
    expect(() => requireScope(tokenActor(["task:*"]), "task:write")).not.toThrow();
  });

  it("passes when token holds the admin wildcard *", () => {
    expect(() => requireScope(tokenActor(["*"]), "task:delete:approve")).not.toThrow();
  });

  it("throws ScopeError when token holds no relevant scope", () => {
    expect(() => requireScope(tokenActor(["project:read"]), "task:write")).toThrowError(ScopeError);
  });

  it("throws ScopeError when token scopes list is empty", () => {
    expect(() => requireScope(tokenActor([]), "task:read")).toThrowError(ScopeError);
  });

  it("ScopeError message names the missing scope", () => {
    try {
      requireScope(tokenActor(["project:read"]), "task:delete");
      // should not reach here
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeError);
      expect((e as ScopeError).message).toContain("task:delete");
    }
  });

  it("thrown ScopeError has status 403", () => {
    try {
      requireScope(tokenActor([]), "task:read");
    } catch (e) {
      expect((e as ScopeError).status).toBe(403);
    }
  });
});

// ---------------------------------------------------------------------------
// User actors — viewer read-only enforcement
// ---------------------------------------------------------------------------
describe("requireScope — user actor (viewer)", () => {
  it("viewer can perform read scopes without error", () => {
    expect(() => requireScope(userActor("viewer"), "task:read")).not.toThrow();
    expect(() => requireScope(userActor("viewer"), "project:read")).not.toThrow();
  });

  it("viewer is blocked from write scopes", () => {
    expect(() => requireScope(userActor("viewer"), "task:write")).toThrowError(ScopeError);
  });

  it("viewer is blocked from delete scopes", () => {
    expect(() => requireScope(userActor("viewer"), "task:delete")).toThrowError(ScopeError);
  });

  it("viewer blocked message mentions read-only", () => {
    try {
      requireScope(userActor("viewer"), "task:write");
    } catch (e) {
      expect((e as ScopeError).message.toLowerCase()).toContain("read-only");
    }
  });
});

// ---------------------------------------------------------------------------
// User actors — non-viewer roles are not blocked by role check
// ---------------------------------------------------------------------------
describe("requireScope — user actor (member / admin)", () => {
  it("member can perform write actions", () => {
    expect(() => requireScope(userActor("member"), "task:write")).not.toThrow();
  });

  it("admin can perform delete actions", () => {
    expect(() => requireScope(userActor("admin"), "task:delete:approve")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Project-deletion four-eyes scopes (devops-wave1b, U2 — Decision 3: maker-
// checker extends to PROJECTS ONLY) — same shape as task:delete:* above.
// ---------------------------------------------------------------------------
describe("requireScope — project:delete:request / project:delete:approve", () => {
  it("throws ScopeError (403) when a token lacks project:delete:request", () => {
    expect(() =>
      requireScope(tokenActor(["project:read", "project:write"]), "project:delete:request"),
    ).toThrowError(ScopeError);
  });

  it("throws ScopeError (403) when a token lacks project:delete:approve", () => {
    expect(() =>
      requireScope(tokenActor(["project:delete:request"]), "project:delete:approve"),
    ).toThrowError(ScopeError);
  });

  it("passes when a token holds the exact required scope", () => {
    expect(() =>
      requireScope(tokenActor(["project:delete:request"]), "project:delete:request"),
    ).not.toThrow();
    expect(() =>
      requireScope(tokenActor(["project:delete:approve"]), "project:delete:approve"),
    ).not.toThrow();
  });

  it("a project:* wildcard covers both — same resource-prefix matching as task:*", () => {
    expect(() =>
      requireScope(tokenActor(["project:*"]), "project:delete:approve"),
    ).not.toThrow();
  });

  it("holding project:delete:request does NOT imply project:delete:approve (distinct scopes)", () => {
    expect(() =>
      requireScope(tokenActor(["project:delete:request"]), "project:delete:approve"),
    ).toThrowError(ScopeError);
  });
});

// ---------------------------------------------------------------------------
// Four-eyes self-approval guard logic (pure, extracted from approve route)
// ---------------------------------------------------------------------------
/**
 * The approve route enforces four-eyes by checking:
 *   if (actor.id === request.requested_by_id) throw new ScopeError(...)
 *
 * We test this logic inline — no DB needed.
 */
function assertNotSelfApproval(actorId: string, requestedById: string): void {
  if (actorId === requestedById) {
    throw new ScopeError("Self-approval is not allowed (four-eyes)");
  }
}

describe("four-eyes: self-approval guard", () => {
  it("rejects when actor.id equals requested_by_id", () => {
    expect(() => assertNotSelfApproval("usr_alice", "usr_alice")).toThrowError(ScopeError);
  });

  it("throws ScopeError (status 403) for self-approval", () => {
    try {
      assertNotSelfApproval("usr_alice", "usr_alice");
    } catch (e) {
      expect(e).toBeInstanceOf(ScopeError);
      expect((e as ScopeError).status).toBe(403);
    }
  });

  it("allows when actor.id differs from requested_by_id", () => {
    expect(() => assertNotSelfApproval("usr_alice", "usr_bob")).not.toThrow();
  });

  it("allows when actor is a token (different id namespace from users)", () => {
    expect(() => assertNotSelfApproval("tok_agent_01", "usr_alice")).not.toThrow();
  });

  it("rejects even for token-self-approval if IDs match", () => {
    expect(() => assertNotSelfApproval("tok_shared", "tok_shared")).toThrowError(ScopeError);
  });
});

// ---------------------------------------------------------------------------
// requireAuth — R-91 MFA gate (assertMfaSatisfied + isMfaChallengeExempt)
//
// @/lib/auth/mfa, next/headers, @/lib/supabase/server and
// @/lib/supabase/admin are mocked above so this exercises guard.ts's own
// wiring (when the MFA check runs, what it does with the result, and which
// paths/actor types skip it) without a live Supabase/Postgres instance.
// ---------------------------------------------------------------------------
function mockSessionActor(profile: {
  workspace_id: string;
  role: string;
  email: string;
  display_name: string | null;
} = { workspace_id: "ws_1", role: "member", email: "alice@example.com", display_name: "Alice" }) {
  createClientMock.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: "usr_1", email: profile.email } } }) },
    from: (table: string) => {
      if (table !== "profiles") throw new Error(`unexpected table: ${table}`);
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }) };
    },
  });
}

function mockTokenActor(overrides: Partial<{
  id: string;
  workspace_id: string;
  name: string;
  scopes: string[];
  revoked: boolean;
  expires_at: string | null;
}> = {}) {
  const row = {
    id: "tok_1",
    workspace_id: "ws_1",
    name: "ci-agent",
    scopes: ["task:read"],
    revoked: false,
    expires_at: null,
    ...overrides,
  };
  createAdminClientMock.mockReturnValue({
    from: (table: string) => {
      if (table !== "api_tokens") throw new Error(`unexpected table: ${table}`);
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      };
    },
  });
}

function request(pathname: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${pathname}`, { headers });
}

beforeEach(() => {
  getMfaEnrollmentStatusMock.mockReset();
  verifyMfaCookieMock.mockReset();
  cookiesGetMock.mockReset();
  createClientMock.mockReset();
  createAdminClientMock.mockReset();
});

describe("requireAuth — MFA gate, session actors", () => {
  it("enrolled + valid nopm_mfa cookie: passes, and checks the cookie against the current enrollment", async () => {
    mockSessionActor();
    getMfaEnrollmentStatusMock.mockResolvedValue({ enabled: true, enr: "enr_current" });
    cookiesGetMock.mockReturnValue({ value: "cookie-value" });
    verifyMfaCookieMock.mockReturnValue(true);

    const actor = await requireAuth(request("/api/tasks"));

    expect(actor.id).toBe("usr_1");
    expect(verifyMfaCookieMock).toHaveBeenCalledWith("cookie-value", "usr_1", "enr_current");
  });

  it("enrolled + no cookie at all: rejects with 401 mfa_required", async () => {
    mockSessionActor();
    getMfaEnrollmentStatusMock.mockResolvedValue({ enabled: true, enr: "enr_current" });
    cookiesGetMock.mockReturnValue(undefined);
    verifyMfaCookieMock.mockReturnValue(false);

    await expect(requireAuth(request("/api/tasks"))).rejects.toMatchObject({
      status: 401,
      code: "mfa_required",
    });
  });

  it("enrolled + cookie bound to a different enrollment (e.g. after disable+re-enroll): rejects with 401 mfa_required", async () => {
    mockSessionActor();
    getMfaEnrollmentStatusMock.mockResolvedValue({ enabled: true, enr: "enr_new" });
    cookiesGetMock.mockReturnValue({ value: "stale-cookie-from-old-enrollment" });
    // verifyMfaCookie itself does the {uid, enr, exp} check (see mfa.test.ts) —
    // here we simulate its real behavior for a mismatched enrollment: false.
    verifyMfaCookieMock.mockReturnValue(false);

    await expect(requireAuth(request("/api/tasks"))).rejects.toBeInstanceOf(AuthError);
    await expect(requireAuth(request("/api/tasks"))).rejects.toMatchObject({ code: "mfa_required" });
  });

  it("not enrolled: passes without ever reading the cookie", async () => {
    mockSessionActor();
    getMfaEnrollmentStatusMock.mockResolvedValue({ enabled: false, enr: null });

    const actor = await requireAuth(request("/api/tasks"));

    expect(actor.id).toBe("usr_1");
    expect(verifyMfaCookieMock).not.toHaveBeenCalled();
    expect(cookiesGetMock).not.toHaveBeenCalled();
  });

  it("user_mfa lookup error: fails closed by rejecting (never resolves an actor) — becomes a sanitized 500 one layer up in route(), not a 401 from guard.ts itself", async () => {
    mockSessionActor();
    getMfaEnrollmentStatusMock.mockRejectedValue(new Error("connection reset"));

    await expect(requireAuth(request("/api/tasks"))).rejects.toThrow("connection reset");
    expect(verifyMfaCookieMock).not.toHaveBeenCalled();
  });
});

describe("requireAuth — MFA gate, token (Bearer PAT) actors never reach it", () => {
  it("a valid bearer token resolves without ever calling getMfaEnrollmentStatus", async () => {
    mockTokenActor();

    const actor = await requireAuth(request("/api/tasks", { authorization: "Bearer npm_abcdef123456" }));

    expect(actor.type).toBe("token");
    expect(getMfaEnrollmentStatusMock).not.toHaveBeenCalled();
    expect(verifyMfaCookieMock).not.toHaveBeenCalled();
  });
});

describe("requireAuth — MFA_CHALLENGE_EXEMPT_PATHS: exact pathname match only", () => {
  beforeEach(() => {
    mockSessionActor();
    // Enrolled + unchallenged for every case below — if the exemption logic
    // is wrong in either direction, this makes the test fail loudly instead
    // of accidentally passing because the gate happened not to trigger.
    getMfaEnrollmentStatusMock.mockResolvedValue({ enabled: true, enr: "enr_current" });
    cookiesGetMock.mockReturnValue(undefined);
    verifyMfaCookieMock.mockReturnValue(false);
  });

  it("GET /api/auth/mfa is exempt (status poll)", async () => {
    await expect(requireAuth(request("/api/auth/mfa"))).resolves.toBeTruthy();
  });

  it("POST /api/auth/mfa/challenge is exempt (the challenge itself)", async () => {
    await expect(requireAuth(request("/api/auth/mfa/challenge"))).resolves.toBeTruthy();
  });

  it("a trailing slash is NOT exempt — different pathname, gate still enforced", async () => {
    await expect(requireAuth(request("/api/auth/mfa/challenge/"))).rejects.toMatchObject({
      code: "mfa_required",
    });
  });

  it("a different case is NOT exempt — pathname match is case-sensitive, gate still enforced", async () => {
    await expect(requireAuth(request("/API/auth/mfa/challenge"))).rejects.toMatchObject({
      code: "mfa_required",
    });
  });

  it("a query string does not break the exemption — URL.pathname excludes the query", async () => {
    await expect(requireAuth(request("/api/auth/mfa/challenge?foo=bar"))).resolves.toBeTruthy();
  });

  it("an unrelated path is NOT exempt — gate still enforced", async () => {
    await expect(requireAuth(request("/api/tasks"))).rejects.toMatchObject({ code: "mfa_required" });
  });
});
