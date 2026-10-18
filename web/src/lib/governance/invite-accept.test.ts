import { describe, it, expect, vi } from "vitest";
import { RuleError } from "@/lib/api/errors";
import { performInviteAccept, type InviteAcceptAdminClient } from "./invite-accept";

const INPUT = {
  tokenHash: "hash-of-npi-token",
  email: "new.hire@example.com",
  password: "correct horse battery staple",
  displayName: "New Hire",
};

function fakeClient(overrides: {
  createUser?: InviteAcceptAdminClient["auth"]["admin"]["createUser"];
  deleteUser?: InviteAcceptAdminClient["auth"]["admin"]["deleteUser"];
  rpc?: InviteAcceptAdminClient["rpc"];
  updateUserById?: InviteAcceptAdminClient["auth"]["admin"]["updateUserById"];
  getUserById?: InviteAcceptAdminClient["auth"]["admin"]["getUserById"];
} = {}): InviteAcceptAdminClient {
  return {
    auth: {
      admin: {
        createUser:
          overrides.createUser ??
          vi.fn(async () => ({ data: { user: { id: "auth-user-1" } }, error: null })),
        deleteUser: overrides.deleteUser ?? vi.fn(async () => ({ error: null })),
        updateUserById: overrides.updateUserById ?? vi.fn(async () => ({ error: null })),
        getUserById:
          overrides.getUserById ??
          vi.fn(async (id: string) => ({
            data: { user: { id, created_at: new Date(Date.now() - 5 * 60_000).toISOString(), user_metadata: {} } },
            error: null,
          })),
      },
    },
    rpc: overrides.rpc ?? vi.fn(async () => ({ data: { profile_id: "auth-user-1", member_id: "m1", workspace_id: "ws1" }, error: null })),
  };
}

describe("performInviteAccept — happy path", () => {
  it("createUser THEN rpc, in that order, and returns the rpc result", async () => {
    const calls: string[] = [];
    const createUser = vi.fn(async () => {
      calls.push("createUser");
      return { data: { user: { id: "auth-user-1" } }, error: null };
    });
    const rpc = vi.fn(async () => {
      calls.push("rpc");
      return { data: { profile_id: "auth-user-1", member_id: "m1", workspace_id: "ws1" }, error: null };
    });
    const db = fakeClient({ createUser, deleteUser: vi.fn(), rpc });

    const result = await performInviteAccept(db, INPUT);

    expect(calls).toEqual(["createUser", "rpc"]);
    expect(result).toEqual({ profile_id: "auth-user-1", member_id: "m1", workspace_id: "ws1" });
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("passes the invite's own email to createUser and to the rpc (never a client-supplied one)", async () => {
    const createUser = vi.fn(async () => ({ data: { user: { id: "auth-user-1" } }, error: null }));
    const rpc = vi.fn(async () => ({ data: {}, error: null }));
    const db = fakeClient({ createUser, rpc });

    await performInviteAccept(db, INPUT);

    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ email: INPUT.email, email_confirm: true }),
    );
    expect(rpc).toHaveBeenCalledWith(
      "nopm_accept_invite",
      expect.objectContaining({ p_email: INPUT.email, p_token_hash: INPUT.tokenHash }),
    );
  });

  it("R-84: passes p_channel/p_correlation_id through to the rpc when given on the input", async () => {
    const rpc = vi.fn(async () => ({ data: {}, error: null }));
    const db = fakeClient({ rpc });

    await performInviteAccept(db, { ...INPUT, channel: "ui", requestId: "req-123" });

    expect(rpc).toHaveBeenCalledWith(
      "nopm_accept_invite",
      expect.objectContaining({ p_channel: "ui", p_correlation_id: "req-123" }),
    );
  });

  it("R-84: defaults p_channel/p_correlation_id to null when the input omits them", async () => {
    const rpc = vi.fn(async () => ({ data: {}, error: null }));
    const db = fakeClient({ rpc });

    await performInviteAccept(db, INPUT);

    expect(rpc).toHaveBeenCalledWith(
      "nopm_accept_invite",
      expect.objectContaining({ p_channel: null, p_correlation_id: null }),
    );
  });
});

describe("performInviteAccept — createUser failure (never reaches the rpc)", () => {
  it("maps an 'already registered' createUser error to a 422 email_exists RuleError", async () => {
    const createUser = vi.fn(async () => ({
      data: { user: null },
      error: { message: "User already registered", code: "email_exists" },
    }));
    const rpc = vi.fn();
    const db = fakeClient({ createUser, rpc });

    await expect(performInviteAccept(db, INPUT)).rejects.toBeInstanceOf(RuleError);
    expect(rpc).not.toHaveBeenCalledWith("nopm_accept_invite", expect.anything());
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("a REAL account (auth user WITH a profile) stays email_exists and is never touched", async () => {
    const createUser = vi.fn(async () => ({ data: { user: null }, error: { message: "x", code: "email_exists" } }));
    const rpc = vi.fn(async () => ({ data: [{ user_id: "real-user", has_profile: true }], error: null }));
    const db = fakeClient({ createUser, rpc });

    await expect(performInviteAccept(db, INPUT)).rejects.toMatchObject({ code: "email_exists" });
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalledWith("nopm_accept_invite", expect.anything());
  });

  it("maps any other createUser failure to a 422, not a raw 500 (public endpoint)", async () => {
    const createUser = vi.fn(async () => ({
      data: { user: null },
      error: { message: "Password does not meet policy" },
    }));
    const db = fakeClient({ createUser, rpc: vi.fn() });

    await expect(performInviteAccept(db, INPUT)).rejects.toBeInstanceOf(RuleError);
  });
});

// ---------------------------------------------------------------------------
// FAILURE-INJECTION (L-48 criterion, f2b-specs.md T7): rpc fails AFTER
// createUser succeeded — assert cleanup (deleteUser) is attempted with the
// just-created user id, and the mapped error still propagates (fail-closed:
// the caller must see a real error, never a silently-swallowed one).
// ---------------------------------------------------------------------------
describe("performInviteAccept — FAILURE INJECTION: rpc fails after createUser succeeded", () => {
  it("calls deleteUser with the created auth user id when the rpc fails (P0002/NOT_FOUND now maps to a 422 RuleError, not 404 — anti-enumeration, T3 F2c-mini)", async () => {
    const createUser = vi.fn(async () => ({ data: { user: { id: "auth-user-orphan" } }, error: null }));
    const deleteUser = vi.fn(async () => ({ error: null }));
    const rpc = vi.fn(async () => ({ data: null, error: { code: "P0002", message: "NOT_FOUND" } }));
    const db = fakeClient({ createUser, deleteUser, rpc });

    await expect(performInviteAccept(db, INPUT)).rejects.toBeInstanceOf(RuleError);

    expect(deleteUser).toHaveBeenCalledTimes(1);
    expect(deleteUser).toHaveBeenCalledWith("auth-user-orphan");
  });

  it("still propagates the mapped rpc error even when the cleanup deleteUser call itself fails", async () => {
    // Fail-soft cleanup (per invite-accept.ts comment): a cleanup failure
    // must NEVER swallow or replace the real (mapped) rpc error — the
    // fail-closed backstop (verifySession's "No workspace profile" 401)
    // covers the stranded-user case regardless of whether cleanup succeeded.
    const createUser = vi.fn(async () => ({ data: { user: { id: "auth-user-orphan" } }, error: null }));
    const deleteUser = vi.fn(async () => {
      throw new Error("deleteUser transport error");
    });
    const rpc = vi.fn(async () => ({ data: null, error: { code: "P0004", message: "EXPIRED" } }));
    const db = fakeClient({ createUser, deleteUser, rpc });

    await expect(performInviteAccept(db, INPUT)).rejects.toThrow(/expired/i);
    expect(deleteUser).toHaveBeenCalledWith("auth-user-orphan");
  });

  it("maps ALREADY_USED (P0001) rpc failure to a RuleError and still cleans up", async () => {
    const createUser = vi.fn(async () => ({ data: { user: { id: "auth-user-2" } }, error: null }));
    const deleteUser = vi.fn(async () => ({ error: null }));
    const rpc = vi.fn(async () => ({ data: null, error: { code: "P0001", message: "ALREADY_USED" } }));
    const db = fakeClient({ createUser, deleteUser, rpc });

    await expect(performInviteAccept(db, INPUT)).rejects.toBeInstanceOf(RuleError);
    expect(deleteUser).toHaveBeenCalledWith("auth-user-2");
  });

  it("never leaves a half-created identity silently unreported — no swallowed rejection", async () => {
    const createUser = vi.fn(async () => ({ data: { user: { id: "auth-user-3" } }, error: null }));
    const deleteUser = vi.fn(async () => ({ error: null }));
    const rpc = vi.fn(async () => ({ data: null, error: { message: "connection reset" } }));
    const db = fakeClient({ createUser, deleteUser, rpc });

    let threw = false;
    try {
      await performInviteAccept(db, INPUT);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// D-ACC-3: retry after a half-finished accept (auth user created, no profile).
// ---------------------------------------------------------------------------
describe("performInviteAccept — retry after a stranded auth user (D-ACC-3)", () => {
  const existsError = { message: "User already registered", code: "email_exists" };

  function retryClient(
    acceptError: { code: string; message: string } | null = null,
    getUserById?: InviteAcceptAdminClient["auth"]["admin"]["getUserById"],
  ) {
    const createUser = vi.fn(async () => ({ data: { user: null }, error: existsError }));
    const rpc = vi.fn(async (fn: string) => {
      if (fn === "nopm_auth_user_for_invite") return { data: [{ user_id: "stranded-1", has_profile: false }], error: null };
      return acceptError
        ? { data: null, error: acceptError }
        : { data: { profile_id: "stranded-1", member_id: "m1", workspace_id: "ws1" }, error: null };
    });
    return { db: fakeClient({ createUser, rpc, getUserById }), rpc };
  }

  it("reuses the stranded user: sets the chosen password, then completes the accept RPC with that id", async () => {
    const { db, rpc } = retryClient();
    const result = await performInviteAccept(db, INPUT);
    expect(result.workspace_id).toBe("ws1");
    expect(db.auth.admin.updateUserById).toHaveBeenCalledWith("stranded-1", {
      password: INPUT.password,
      email_confirm: true,
    });
    expect(rpc).toHaveBeenCalledWith("nopm_accept_invite", expect.objectContaining({ p_auth_user_id: "stranded-1" }));
  });

  const userAged = (ageMs: number, meta: Record<string, unknown> = {}) =>
    vi.fn(async (id: string) => ({
      data: { user: { id, created_at: new Date(Date.now() - ageMs).toISOString(), user_metadata: meta } },
      error: null,
    }));

  it("R-16: stamps the invite id on the auth user it creates", async () => {
    const createUser = vi.fn(async () => ({ data: { user: { id: "u1" } }, error: null }));
    await performInviteAccept(fakeClient({ createUser }), { ...INPUT, inviteId: "inv-1" });
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ user_metadata: { invite_id: "inv-1" } }));
  });

  it("R-16: a profile-less user older than an hour is NOT adopted (409 email_exists)", async () => {
    const { db } = retryClient(null, userAged(2 * 60 * 60 * 1000));
    await expect(performInviteAccept(db, INPUT)).rejects.toMatchObject({ code: "email_exists" });
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it("R-16: a recent user stamped with a DIFFERENT invite is NOT adopted", async () => {
    const { db } = retryClient(null, userAged(60_000, { invite_id: "other" }));
    await expect(performInviteAccept(db, { ...INPUT, inviteId: "inv-1" })).rejects.toMatchObject({ code: "email_exists" });
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled();
  });

  it("R-16: a recent user stamped with THIS invite is adopted", async () => {
    const { db } = retryClient(null, userAged(60_000, { invite_id: "inv-1" }));
    await performInviteAccept(db, { ...INPUT, inviteId: "inv-1" });
    expect(db.auth.admin.updateUserById).toHaveBeenCalled();
  });

  it("R-16: if the user's age cannot be read it is not adopted", async () => {
    const { db } = retryClient(null, vi.fn(async () => ({ data: null, error: { message: "boom" } })));
    await expect(performInviteAccept(db, INPUT)).rejects.toMatchObject({ code: "email_exists" });
  });

  it("does NOT delete a reused identity when the RPC fails again (the next retry can pick it up)", async () => {
    const { db } = retryClient({ code: "P0002", message: "NOT_FOUND" });
    await expect(performInviteAccept(db, INPUT)).rejects.toBeInstanceOf(RuleError);
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});
