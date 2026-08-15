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
} = {}): InviteAcceptAdminClient {
  return {
    auth: {
      admin: {
        createUser:
          overrides.createUser ??
          vi.fn(async () => ({ data: { user: { id: "auth-user-1" } }, error: null })),
        deleteUser: overrides.deleteUser ?? vi.fn(async () => ({ error: null })),
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
    expect(rpc).not.toHaveBeenCalled();
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
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
