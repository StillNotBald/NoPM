import { describe, it, expect } from "vitest";
import { requireScope, type Actor } from "./guard";
import { ScopeError } from "@/lib/api/errors";

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
