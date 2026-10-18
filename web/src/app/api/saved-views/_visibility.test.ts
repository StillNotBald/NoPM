import { describe, it, expect } from "vitest";
import { isVisibleToActor, visibilityOrFilter, canActorMutate, assertConfigMutable, resolveAuditAction } from "./_visibility";
import type { Actor } from "@/lib/auth/guard";
import { ScopeError } from "@/lib/api/errors";

const ALICE = "aaaaaaaa-1111-4111-8111-111111111111";
const BOB = "bbbbbbbb-2222-4222-8222-222222222222";

function userActor(id: string, role = "member"): Actor {
  return { type: "user", id, label: id, workspaceId: "ws-1", role };
}
function tokenActor(id: string): Actor {
  return { type: "token", id, label: "agent", workspaceId: "ws-1", scopes: ["saved_view:read", "saved_view:write"] };
}

describe("isVisibleToActor / visibilityOrFilter — L-41 personal-view privacy", () => {
  it("a personal view is visible to its owner", () => {
    expect(isVisibleToActor({ scope: "personal", owner_id: ALICE }, ALICE)).toBe(true);
  });

  it("a personal view is INVISIBLE to a second identity — the exact L-41 verification shape", () => {
    // "verified by logging in as a second identity, not by an admin-based query"
    expect(isVisibleToActor({ scope: "personal", owner_id: ALICE }, BOB)).toBe(false);
  });

  it("a personal view is invisible to a token/agent actor that isn't its owner", () => {
    expect(isVisibleToActor({ scope: "personal", owner_id: ALICE }, "some-token-id")).toBe(false);
  });

  it("a shared view is visible to anyone in the workspace, including a non-owner", () => {
    expect(isVisibleToActor({ scope: "shared", owner_id: ALICE }, BOB)).toBe(true);
    expect(isVisibleToActor({ scope: "shared", owner_id: null }, BOB)).toBe(true);
  });

  it("visibilityOrFilter embeds the caller's own id as the owner clause", () => {
    expect(visibilityOrFilter(ALICE)).toBe(`scope.eq.shared,owner_id.eq.${ALICE}`);
  });
});

describe("canActorMutate — owner-or-admin write gate (L-06: 'only the owner or an admin may unshare')", () => {
  it("the owner may mutate their own personal view", () => {
    expect(canActorMutate({ owner_id: ALICE, scope: "personal" }, userActor(ALICE))).toBe(true);
  });

  it("a non-owner, non-admin member may NOT mutate someone else's personal view", () => {
    expect(canActorMutate({ owner_id: ALICE, scope: "personal" }, userActor(BOB, "member"))).toBe(false);
  });

  it("a workspace admin may mutate any view even if not the owner", () => {
    expect(canActorMutate({ owner_id: ALICE, scope: "personal" }, userActor(BOB, "admin"))).toBe(true);
    expect(canActorMutate({ owner_id: ALICE, scope: "shared" }, userActor(BOB, "admin"))).toBe(true);
  });

  it("a non-owner, non-admin member may NOT mutate someone else's shared view either", () => {
    expect(canActorMutate({ owner_id: ALICE, scope: "shared" }, userActor(BOB, "member"))).toBe(false);
  });

  it("a token actor (saved_view:write) may manage a SHARED workspace view", () => {
    expect(canActorMutate({ owner_id: null, scope: "shared" }, tokenActor("token-1"))).toBe(true);
  });

  it("a token actor can never touch a human's still-personal view, even by guessing its id", () => {
    expect(canActorMutate({ owner_id: ALICE, scope: "personal" }, tokenActor("token-1"))).toBe(false);
  });
});

describe("assertConfigMutable — L-07 protected-403 logic", () => {
  it("allows a config PATCH on an unprotected view", () => {
    expect(() => assertConfigMutable({ protected: false }, { config: { filters: {} } })).not.toThrow();
  });

  it("rejects a config PATCH on a protected view with a 403 (ScopeError)", () => {
    expect(() => assertConfigMutable({ protected: true }, { config: { filters: {} } })).toThrow(ScopeError);
    try {
      assertConfigMutable({ protected: true }, { config: { filters: {} } });
    } catch (err) {
      expect(err).toBeInstanceOf(ScopeError);
      expect((err as ScopeError).status).toBe(403);
    }
  });

  it("allows a config PATCH on a protected view IF the same call unprotects it", () => {
    expect(() =>
      assertConfigMutable({ protected: true }, { config: { filters: {} }, protected: false }),
    ).not.toThrow();
  });

  it("a protected view still accepts a non-config PATCH (e.g. name only)", () => {
    expect(() => assertConfigMutable({ protected: true }, { name: "Renamed" } as never)).not.toThrow();
  });

  it("setting protected:true alongside a config change does NOT bypass the guard", () => {
    expect(() =>
      assertConfigMutable({ protected: true }, { config: { filters: {} }, protected: true }),
    ).toThrow(ScopeError);
  });
});

describe("resolveAuditAction — one PATCH call, one specific verb", () => {
  it("a protected-flag change is saved_view.protected even if scope also changed", () => {
    expect(resolveAuditAction({ protected: true, scope: "shared" })).toBe("saved_view.protected");
  });

  it("a scope-only change is saved_view.shared", () => {
    expect(resolveAuditAction({ scope: "shared" })).toBe("saved_view.shared");
  });

  it("a plain field change (name/config) is saved_view.update", () => {
    expect(resolveAuditAction({ name: "Renamed" })).toBe("saved_view.update");
    expect(resolveAuditAction({ config: { filters: {} } })).toBe("saved_view.update");
  });
});
