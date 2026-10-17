/**
 * Principal resolution (2026-10-16, D1): requireAuth stamps `Actor.principalId`
 * with the HUMAN behind the actor — a session user is their own principal, a
 * Bearer PAT is its `api_tokens.created_by`, and a token with no recorded
 * creator resolves to null (which can never approve; see
 * @/lib/governance/decide). Four-eyes compares this field, never the actor id.
 *
 * Supabase, next/headers and the MFA module are mocked exactly like
 * guard.test.ts so only guard.ts's own wiring is exercised.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getMfaEnrollmentStatusMock, verifyMfaCookieMock } = vi.hoisted(() => ({
  getMfaEnrollmentStatusMock: vi.fn(),
  verifyMfaCookieMock: vi.fn(),
}));
vi.mock("@/lib/auth/mfa", () => ({
  MFA_COOKIE_NAME: "nopm_mfa",
  getMfaEnrollmentStatus: getMfaEnrollmentStatusMock,
  verifyMfaCookie: verifyMfaCookieMock,
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: vi.fn() }) }));

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

const { createAdminClientMock } = vi.hoisted(() => ({ createAdminClientMock: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: (...args: unknown[]) => createAdminClientMock(...args),
}));

import { requireAuth } from "./guard";

const selectSpy = vi.fn();
const profileRow = {
  current: { workspace_id: "ws-1", role: "manager" } as { workspace_id: string; role: string } | null,
};

function mockToken(createdBy: string | null | undefined) {
  const row: Record<string, unknown> = {
    id: "tok-1",
    workspace_id: "ws-1",
    name: "agent",
    scopes: ["task:read"],
    revoked: false,
    expires_at: null,
  };
  if (createdBy !== undefined) row.created_by = createdBy;
  createAdminClientMock.mockReturnValue({
    from: (table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: profileRow.current, error: null }) }),
          }),
        };
      }
      if (table !== "api_tokens") throw new Error(`unexpected table: ${table}`);
      return {
        select: (cols: string) => {
          selectSpy(cols);
          return { eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) };
        },
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      };
    },
  });
}

function mockSession(userId: string) {
  createClientMock.mockResolvedValue({
    auth: { getUser: async () => ({ data: { user: { id: userId, email: "p@example.com" } } }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { workspace_id: "ws-1", role: "member", email: "p@example.com", display_name: "P" },
            error: null,
          }),
        }),
      }),
    }),
  });
}

const bearer = () =>
  new Request("http://localhost/api/tasks", { headers: { authorization: "Bearer npm_abcdef123456" } });
const cookieReq = () => new Request("http://localhost/api/tasks");

beforeEach(() => {
  vi.clearAllMocks();
  profileRow.current = { workspace_id: "ws-1", role: "manager" };
  getMfaEnrollmentStatusMock.mockResolvedValue({ enabled: false, enr: null });
});

describe("requireAuth — principalId", () => {
  it("a session user is their own principal", async () => {
    mockSession("user-42");
    const actor = await requireAuth(cookieReq());
    expect(actor.type).toBe("user");
    expect(actor.id).toBe("user-42");
    expect(actor.principalId).toBe("user-42");
  });

  it("a PAT's principal is api_tokens.created_by, NOT the token id", async () => {
    mockToken("owner-profile-7");
    const actor = await requireAuth(bearer());
    expect(actor.type).toBe("token");
    expect(actor.id).toBe("tok-1");
    expect(actor.principalId).toBe("owner-profile-7");
    expect(actor.principalId).not.toBe(actor.id);
  });

  it("a legacy PAT with a NULL created_by resolves to a null principal (fail-closed downstream)", async () => {
    mockToken(null);
    const actor = await requireAuth(bearer());
    expect(actor.principalId).toBeNull();
  });

  it("a token row that omits created_by entirely also resolves to null, never undefined-as-owner", async () => {
    mockToken(undefined);
    const actor = await requireAuth(bearer());
    expect(actor.principalId).toBeNull();
  });

  it("selects created_by from api_tokens (the column was never read before)", async () => {
    mockToken("owner-profile-7");
    await requireAuth(bearer());
    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(selectSpy.mock.calls[0][0]).toContain("created_by");
  });
});

/**
 * last_used_at (CR-gov P1-4): supabase-js builders are LAZY thenables — the
 * request is only sent when `.then()` is called. The old `void builder` never
 * called it, so no token ever got a last_used_at. This mock only "sends" the
 * update when something subscribes, exactly like the real builder.
 */
describe("requireAuth — api_tokens.last_used_at", () => {
  const sent: Array<Record<string, unknown>> = [];

  function mockLazyToken(lastUsedAt: string | null) {
    const row = {
      id: "tok-1",
      workspace_id: "ws-1",
      name: "agent",
      scopes: ["task:read"],
      revoked: false,
      expires_at: null,
      created_by: "owner-1",
      last_used_at: lastUsedAt,
    };
    createAdminClientMock.mockReturnValue({
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: table === "profiles" ? { workspace_id: "ws-1", role: "member" } : row,
              error: null,
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: () => ({
            then(onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
              sent.push(patch); // the "network request" happens only here
              return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
            },
          }),
        }),
      }),
    });
  }

  beforeEach(() => {
    sent.length = 0;
  });

  it("actually sends the update (a lazy builder that is never awaited sends nothing)", async () => {
    mockLazyToken(null);
    await requireAuth(bearer());
    expect(sent).toHaveLength(1);
    expect(typeof sent[0].last_used_at).toBe("string");
  });

  it("sends when the stored value is older than 5 minutes", async () => {
    mockLazyToken(new Date(Date.now() - 6 * 60 * 1000).toISOString());
    await requireAuth(bearer());
    expect(sent).toHaveLength(1);
  });

  it("skips the write when the stored value is under 5 minutes old", async () => {
    mockLazyToken(new Date(Date.now() - 60 * 1000).toISOString());
    await requireAuth(bearer());
    expect(sent).toHaveLength(0);
  });

  it("a failing touch never breaks authentication", async () => {
    createAdminClientMock.mockReturnValue({
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: table === "profiles" ? { workspace_id: "ws-1", role: "member" } : {
                id: "tok-1",
                workspace_id: "ws-1",
                name: "agent",
                scopes: [],
                revoked: false,
                expires_at: null,
                created_by: "owner-1",
                last_used_at: null,
              },
              error: null,
            }),
          }),
        }),
        update: () => ({
          eq: () => ({
            then(_ok?: unknown, onRejected?: (e: unknown) => unknown) {
              return Promise.reject(new Error("db down")).then(undefined, onRejected);
            },
          }),
        }),
      }),
    });
    await expect(requireAuth(bearer())).resolves.toMatchObject({ type: "token", id: "tok-1" });
  });
});

describe("requireAuth — token creator must still exist (D-ACC-2 / A1-4 / A2-6)", () => {
  it("a token whose creator's profile is gone no longer authenticates (401)", async () => {
    mockToken("gone-profile");
    profileRow.current = null;
    await expect(requireAuth(bearer())).rejects.toMatchObject({ status: 401 });
  });

  it("a token whose creator now belongs to a different workspace is refused", async () => {
    mockToken("moved-profile");
    profileRow.current = { workspace_id: "ws-OTHER", role: "admin" };
    await expect(requireAuth(bearer())).rejects.toMatchObject({ status: 401 });
  });

  it("principalRole is the creator's CURRENT role", async () => {
    mockToken("owner-profile-7");
    profileRow.current = { workspace_id: "ws-1", role: "viewer" };
    const actor = await requireAuth(bearer());
    expect(actor.principalRole).toBe("viewer");
  });

  it("a legacy token with no creator keeps working with a null principalRole (no profile lookup)", async () => {
    mockToken(null);
    profileRow.current = null;
    const actor = await requireAuth(bearer());
    expect(actor.principalRole).toBeNull();
  });

  it("a session user's principalRole is their own role", async () => {
    mockSession("user-42");
    const actor = await requireAuth(cookieReq());
    expect(actor.principalRole).toBe("member");
  });
});

describe("requireAuth — failed bearer auth is rate limited per client IP before the lookup (A1-8)", () => {
  const rpc = vi.fn();
  function mockUnknownToken() {
    createAdminClientMock.mockReturnValue({
      rpc,
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    });
  }
  const bearerFromIp = () =>
    new Request("http://localhost/api/tasks", {
      headers: { authorization: "Bearer npm_nope", "x-forwarded-for": "203.0.113.9" },
    });

  beforeEach(() => {
    rpc.mockReset();
    vi.stubEnv("NOPM_TRUSTED_PROXY_HOPS", "1");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("429s with the retry-after seconds when the IP is already over budget, without touching api_tokens", async () => {
    const fromSpy = vi.fn();
    createAdminClientMock.mockReturnValue({
      rpc: async () => ({ data: { allowed: false, retry_after_seconds: 41 }, error: null }),
      from: fromSpy,
    });
    const err = await requireAuth(bearerFromIp()).catch((e) => e);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(41);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("counts an unknown token against the IP", async () => {
    mockUnknownToken();
    rpc.mockResolvedValue({ data: { allowed: true, retry_after_seconds: 0 }, error: null });
    await expect(requireAuth(bearerFromIp())).rejects.toMatchObject({ status: 401 });
    expect(rpc).toHaveBeenCalledWith("nopm_rate_peek", expect.objectContaining({ p_key: "bearer-fail:203.0.113.9" }));
    expect(rpc).toHaveBeenCalledWith("nopm_rate_check", expect.objectContaining({ p_key: "bearer-fail:203.0.113.9" }));
  });

  it("skips the IP cap when no trustworthy address exists", async () => {
    vi.unstubAllEnvs();
    mockUnknownToken();
    await expect(requireAuth(bearer())).rejects.toMatchObject({ status: 401 });
    expect(rpc).not.toHaveBeenCalled();
  });
});
