import { describe, it, expect } from "vitest";
import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import {
  assertCanManageInvites,
  assertRoleWithinCap,
  assertRevocable,
  assertInviteAcceptable,
  deriveInviteStatus,
  mapAcceptRpcError,
  type InviteRow,
} from "./invite-guard";
import type { Actor } from "@/lib/auth/guard";

function userActor(role: string): Actor {
  return { type: "user", id: "u1", label: "Alice", workspaceId: "ws1", role };
}

function tokenActor(): Actor {
  return { type: "token", id: "t1", label: "ci-bot", workspaceId: "ws1", scopes: ["*"] };
}

function invite(overrides: Partial<InviteRow> = {}): InviteRow {
  return {
    revoked: false,
    accepted_at: null,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// assertCanManageInvites (D5)
// ---------------------------------------------------------------------------
describe("assertCanManageInvites", () => {
  it("allows an admin user session", () => {
    expect(() => assertCanManageInvites(userActor("admin"))).not.toThrow();
  });

  it("allows a manager user session", () => {
    expect(() => assertCanManageInvites(userActor("manager"))).not.toThrow();
  });

  it("blocks a member user session (403 ScopeError)", () => {
    expect(() => assertCanManageInvites(userActor("member"))).toThrow(ScopeError);
  });

  it("blocks a viewer user session (403 ScopeError)", () => {
    expect(() => assertCanManageInvites(userActor("viewer"))).toThrow(ScopeError);
  });

  it("blocks EVERY token/agent actor, regardless of scopes (403 ScopeError)", () => {
    expect(() => assertCanManageInvites(tokenActor())).toThrow(ScopeError);
  });
});

// ---------------------------------------------------------------------------
// assertRoleWithinCap (D5 — role-escalation cap)
// ---------------------------------------------------------------------------
describe("assertRoleWithinCap — role-escalation cap (D5)", () => {
  it("an admin creator may mint an admin invite", () => {
    expect(() => assertRoleWithinCap("admin", "admin")).not.toThrow();
  });

  it("an admin creator may mint a manager/member/viewer invite", () => {
    expect(() => assertRoleWithinCap("admin", "manager")).not.toThrow();
    expect(() => assertRoleWithinCap("admin", "member")).not.toThrow();
    expect(() => assertRoleWithinCap("admin", "viewer")).not.toThrow();
  });

  it("a manager creator may mint a manager invite (equal rank is allowed — <=, not <)", () => {
    expect(() => assertRoleWithinCap("manager", "manager")).not.toThrow();
  });

  it("a manager creator may mint member/viewer invites", () => {
    expect(() => assertRoleWithinCap("manager", "member")).not.toThrow();
    expect(() => assertRoleWithinCap("manager", "viewer")).not.toThrow();
  });

  it("a manager creator CANNOT mint an admin invite (422 RuleError)", () => {
    expect(() => assertRoleWithinCap("manager", "admin")).toThrow(RuleError);
  });

  it("an unrecognised invite role is rejected (fails closed, never silently allowed)", () => {
    expect(() => assertRoleWithinCap("admin", "superadmin")).toThrow(RuleError);
  });
});

// ---------------------------------------------------------------------------
// deriveInviteStatus / assertRevocable / assertInviteAcceptable
// ---------------------------------------------------------------------------
describe("deriveInviteStatus", () => {
  const now = new Date("2026-08-15T00:00:00Z");

  it("pending: not revoked, not accepted, not expired", () => {
    expect(deriveInviteStatus(invite(), now)).toBe("pending");
  });

  it("revoked wins even if also expired or accepted", () => {
    expect(
      deriveInviteStatus(invite({ revoked: true, accepted_at: "2026-08-01T00:00:00Z" }), now),
    ).toBe("revoked");
  });

  it("accepted when accepted_at is set (and not revoked)", () => {
    expect(deriveInviteStatus(invite({ accepted_at: "2026-08-01T00:00:00Z" }), now)).toBe("accepted");
  });

  it("expired when expires_at has passed and not revoked/accepted", () => {
    expect(deriveInviteStatus(invite({ expires_at: "2026-08-01T00:00:00Z" }), now)).toBe("expired");
  });
});

describe("assertRevocable", () => {
  const now = new Date("2026-08-15T00:00:00Z");

  it("passes for a pending invite", () => {
    expect(() => assertRevocable(invite(), now)).not.toThrow();
  });

  it("422s an already-accepted invite", () => {
    expect(() =>
      assertRevocable(invite({ accepted_at: "2026-08-01T00:00:00Z" }), now),
    ).toThrow(RuleError);
  });

  it("422s an already-revoked invite", () => {
    expect(() => assertRevocable(invite({ revoked: true }), now)).toThrow(RuleError);
  });

  it("422s an expired invite", () => {
    expect(() => assertRevocable(invite({ expires_at: "2026-08-01T00:00:00Z" }), now)).toThrow(RuleError);
  });
});

describe("assertInviteAcceptable", () => {
  const now = new Date("2026-08-15T00:00:00Z");

  it("passes for a pending invite", () => {
    expect(() => assertInviteAcceptable(invite(), now)).not.toThrow();
  });

  it("422s an already-accepted invite ('already used')", () => {
    expect(() =>
      assertInviteAcceptable(invite({ accepted_at: "2026-08-01T00:00:00Z" }), now),
    ).toThrow(RuleError);
  });

  it("422s a revoked invite ('already used')", () => {
    expect(() => assertInviteAcceptable(invite({ revoked: true }), now)).toThrow(RuleError);
  });

  it("422s an expired invite with a DISTINCT message from already-used", () => {
    try {
      assertInviteAcceptable(invite({ expires_at: "2026-08-01T00:00:00Z" }), now);
      throw new Error("expected assertInviteAcceptable to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RuleError);
      expect((e as RuleError).message).toMatch(/expired/i);
    }
  });
});

// ---------------------------------------------------------------------------
// mapAcceptRpcError — P-code mapping (mirrors deletion-commit RPC mapping)
// ---------------------------------------------------------------------------
describe("mapAcceptRpcError", () => {
  it("maps P0002 / NOT_FOUND to NotFoundError (404)", () => {
    expect(mapAcceptRpcError({ code: "P0002" })).toBeInstanceOf(NotFoundError);
    expect(mapAcceptRpcError({ message: "NOT_FOUND" })).toBeInstanceOf(NotFoundError);
  });

  it("maps P0001 / ALREADY_USED to RuleError (422)", () => {
    expect(mapAcceptRpcError({ code: "P0001" })).toBeInstanceOf(RuleError);
    expect(mapAcceptRpcError({ message: "ALREADY_USED" })).toBeInstanceOf(RuleError);
  });

  it("maps P0004 / EXPIRED to RuleError (422)", () => {
    expect(mapAcceptRpcError({ code: "P0004" })).toBeInstanceOf(RuleError);
    expect(mapAcceptRpcError({ message: "EXPIRED" })).toBeInstanceOf(RuleError);
  });

  it("falls back to a generic Error for an unrecognised RPC failure", () => {
    const e = mapAcceptRpcError({ message: "connection reset" });
    expect(e).not.toBeInstanceOf(NotFoundError);
    expect(e).not.toBeInstanceOf(RuleError);
    expect(e.message).toBe("connection reset");
  });

  it("handles a null/undefined error gracefully", () => {
    expect(() => mapAcceptRpcError(null)).not.toThrow();
    expect(mapAcceptRpcError(undefined).message).toBe("Failed to accept invite");
  });
});
