import { describe, it, expect } from "vitest";
import { decideSessionGuardStatus } from "./use-require-session";

// ---------------------------------------------------------------------------
// decideSessionGuardStatus — pure decision logic extracted from
// useRequireSession so it can be tested without mounting React or hitting
// the network. The hook itself just wires this decision to
// supabase.auth.getUser() + router.replace("/login").
// ---------------------------------------------------------------------------

describe("decideSessionGuardStatus", () => {
  it("returns authenticated when the check succeeds and a user is present", () => {
    expect(decideSessionGuardStatus({ ok: true, hasUser: true })).toBe("authenticated");
  });

  it("returns unauthenticated when the check succeeds but there is no user", () => {
    expect(decideSessionGuardStatus({ ok: true, hasUser: false })).toBe("unauthenticated");
  });

  it("fails closed: returns unauthenticated when the check itself errored/rejected", () => {
    expect(decideSessionGuardStatus({ ok: false })).toBe("unauthenticated");
  });

  it("never returns the transient checking state", () => {
    const outcomes: Array<{ ok: true; hasUser: boolean } | { ok: false }> = [
      { ok: true, hasUser: true },
      { ok: true, hasUser: false },
      { ok: false },
    ];
    for (const outcome of outcomes) {
      expect(decideSessionGuardStatus(outcome)).not.toBe("checking");
    }
  });
});
