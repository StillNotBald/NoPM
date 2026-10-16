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
import { describe, it, expect, vi, beforeEach } from "vitest";

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
