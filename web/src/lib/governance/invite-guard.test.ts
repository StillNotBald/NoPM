import { describe, it, expect } from "vitest";
import { RuleError, ScopeError } from "@/lib/api/errors";
import {
  assertCanManageInvites,
  assertRoleWithinCap,
  assertRevocable,
  assertInviteAcceptable,
  deriveInviteStatus,
  mapAcceptRpcError,
  throwInviteNotAcceptable,
  INVITE_ACCEPT_ERROR_MESSAGE,
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

// ---------------------------------------------------------------------------
// assertInviteAcceptable / throwInviteNotAcceptable — T3 (F2c-mini)
// anti-enumeration: not-found, expired, already-used, and revoked ALL
// collapse into the SAME 422 message (previously distinct per status,
// which was itself an enumeration oracle for a scripted caller).
// ---------------------------------------------------------------------------
describe("assertInviteAcceptable — anti-enumeration (T3, F2c-mini)", () => {
  const now = new Date("2026-08-15T00:00:00Z");

  it("passes for a pending invite", () => {
    expect(() => assertInviteAcceptable(invite(), now)).not.toThrow();
  });

  it("422s an already-accepted invite with the uniform message", () => {
    expect(() =>
      assertInviteAcceptable(invite({ accepted_at: "2026-08-01T00:00:00Z" }), now),
    ).toThrow(RuleError);
    try {
      assertInviteAcceptable(invite({ accepted_at: "2026-08-01T00:00:00Z" }), now);
    } catch (e) {
      expect((e as RuleError).message).toBe(INVITE_ACCEPT_ERROR_MESSAGE);
    }
  });

  it("422s a revoked invite with the SAME uniform message as already-used", () => {
    try {
      assertInviteAcceptable(invite({ revoked: true }), now);
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RuleError);
      expect((e as RuleError).message).toBe(INVITE_ACCEPT_ERROR_MESSAGE);
    }
  });

  it("422s an expired invite with the SAME uniform message (no longer distinct — anti-enumeration)", () => {
    try {
      assertInviteAcceptable(invite({ expires_at: "2026-08-01T00:00:00Z" }), now);
      throw new Error("expected assertInviteAcceptable to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RuleError);
      expect((e as RuleError).message).toBe(INVITE_ACCEPT_ERROR_MESSAGE);
    }
  });

  it("expired/used/revoked are indistinguishable by message (the anti-enumeration guarantee)", () => {
    const messages = [
      invite({ accepted_at: "2026-08-01T00:00:00Z" }),
      invite({ revoked: true }),
      invite({ expires_at: "2026-08-01T00:00:00Z" }),
    ].map((row) => {
      try {
        assertInviteAcceptable(row, now);
        return null;
      } catch (e) {
        return (e as RuleError).message;
      }
    });
    expect(new Set(messages).size).toBe(1);
  });
});

describe("throwInviteNotAcceptable", () => {
  it("throws a RuleError with the SAME uniform message the accept route uses for a missing token", () => {
    try {
      throwInviteNotAcceptable();
      throw new Error("expected to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RuleError);
      expect((e as RuleError).message).toBe(INVITE_ACCEPT_ERROR_MESSAGE);
    }
  });
});

// ---------------------------------------------------------------------------
// mapAcceptRpcError — P-code mapping, collapsed to the uniform anti-
// enumeration message (T3, F2c-mini). Previously NOT_FOUND mapped to a 404
// NotFoundError while ALREADY_USED/EXPIRED mapped to two distinct 422
// messages — all three now map to the SAME RuleError/message so the RPC
// failure path can never be used to distinguish invite states either.
// ---------------------------------------------------------------------------
describe("mapAcceptRpcError — anti-enumeration (T3, F2c-mini)", () => {
  it("maps P0002 / NOT_FOUND to the uniform RuleError (422, not 404)", () => {
    expect(mapAcceptRpcError({ code: "P0002" })).toBeInstanceOf(RuleError);
    expect(mapAcceptRpcError({ code: "P0002" }).message).toBe(INVITE_ACCEPT_ERROR_MESSAGE);
    expect(mapAcceptRpcError({ message: "NOT_FOUND" }).message).toBe(INVITE_ACCEPT_ERROR_MESSAGE);
  });

  it("maps P0001 / ALREADY_USED to the uniform RuleError (422)", () => {
    expect(mapAcceptRpcError({ code: "P0001" })).toBeInstanceOf(RuleError);
    expect(mapAcceptRpcError({ code: "P0001" }).message).toBe(INVITE_ACCEPT_ERROR_MESSAGE);
    expect(mapAcceptRpcError({ message: "ALREADY_USED" }).message).toBe(INVITE_ACCEPT_ERROR_MESSAGE);
  });

  it("maps P0004 / EXPIRED to the uniform RuleError (422) — SAME message as NOT_FOUND/ALREADY_USED", () => {
    expect(mapAcceptRpcError({ code: "P0004" })).toBeInstanceOf(RuleError);
    const messages = [
      mapAcceptRpcError({ code: "P0002" }).message,
      mapAcceptRpcError({ code: "P0001" }).message,
      mapAcceptRpcError({ code: "P0004" }).message,
    ];
    expect(new Set(messages).size).toBe(1);
  });

  it("falls back to a generic Error for an unrecognised RPC failure", () => {
    const e = mapAcceptRpcError({ message: "connection reset" });
    expect(e).not.toBeInstanceOf(RuleError);
    expect(e.message).toBe("connection reset");
  });

  it("handles a null/undefined error gracefully", () => {
    expect(() => mapAcceptRpcError(null)).not.toThrow();
    expect(mapAcceptRpcError(undefined).message).toBe("Failed to accept invite");
  });
});
