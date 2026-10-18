import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Actor } from "@/lib/auth/guard";

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  updateUser: vi.fn(),
  listUsers: vi.fn(),
  status: "active" as string | null,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: h.rpc,
    from: () => {
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = () => b;
      b.maybeSingle = async () => ({ data: h.status ? { status: h.status } : null, error: null });
      return b;
    },
    auth: { admin: { updateUserById: h.updateUser, listUsers: h.listUsers } },
  }),
}));
vi.mock("@/lib/crypto", () => ({ encrypt: (s: string) => `enc(${s.length})` }));
vi.mock("@/lib/auth/demo", () => ({ DEMO_RESTRICTED_MESSAGE: "demo", isDemoActor: async () => false }));

import {
  assertCanListMembers,
  assertMemberAdminSession,
  changeMemberRole,
  mapMemberRpcError,
  removeMember,
  resetMemberMfa,
  restoreMember,
  LAST_ADMIN_MESSAGE,
  LAST_SIGN_IN_MAX_PAGES,
  LAST_SIGN_IN_PAGE_SIZE,
  memberLastSignIns,
} from "./members";

const admin: Actor = { type: "user", id: "a1", label: "Admin", workspaceId: "ws", role: "admin", principalId: "a1" };

beforeEach(() => {
  h.status = "active";
  h.rpc.mockReset();
  h.updateUser.mockReset();
  h.listUsers.mockReset();
  h.updateUser.mockResolvedValue({ error: null });
});

describe("guards", () => {
  it("only user sessions manage people; tokens are refused", async () => {
    await expect(assertMemberAdminSession({ ...admin, type: "token" })).rejects.toMatchObject({ status: 403 });
    await expect(assertMemberAdminSession(admin)).resolves.toBeUndefined();
  });
  it("listing is admin or manager only", () => {
    expect(() => assertCanListMembers({ ...admin, role: "member" })).toThrow();
    expect(() => assertCanListMembers({ ...admin, role: "manager" })).not.toThrow();
  });
});

describe("error mapping", () => {
  it("last admin -> 422 with the plain message", () => {
    const e = mapMemberRpcError({ message: "LAST_ADMIN", code: "P0010" }) as unknown as { status: number; message: string };
    expect(e.status).toBe(422);
    expect(e.message).toBe(LAST_ADMIN_MESSAGE);
  });
  it("non-admin -> 403, unknown -> 404", () => {
    expect((mapMemberRpcError({ code: "P0018", message: "ROLE_NOT_PERMITTED" }) as unknown as { status: number }).status).toBe(403);
    expect((mapMemberRpcError({ code: "P0002", message: "NOT_FOUND" }) as unknown as { status: number }).status).toBe(404);
  });
});

describe("role change / remove / restore", () => {
  it("passes the actor and the role to the transactional RPC", async () => {
    h.rpc.mockResolvedValue({ data: { member: { id: "t" } }, error: null });
    await changeMemberRole(admin, "t", "manager");
    expect(h.rpc).toHaveBeenCalledWith(
      "nopm_member_change",
      expect.objectContaining({ p_workspace_id: "ws", p_target_id: "t", p_action: "set_role", p_new_role: "manager", p_actor_id: "a1" }),
    );
    expect(h.updateUser).not.toHaveBeenCalled();
  });

  it("a refused last-admin removal does not ban the login", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "LAST_ADMIN", code: "P0010" } });
    await expect(removeMember(admin, "a1")).rejects.toMatchObject({ code: "last_admin" });
    expect(h.updateUser).not.toHaveBeenCalled();
  });

  it("removal bans the login after the RPC", async () => {
    h.rpc.mockResolvedValue({ data: { member: { id: "t" }, revoked_tokens: ["k"], cancelled_invites: [] }, error: null });
    const r = await removeMember(admin, "t");
    expect(h.updateUser).toHaveBeenCalledWith("t", { ban_duration: "876000h" });
    expect(r.already_removed).toBe(false);
    expect(r.revoked_tokens).toEqual(["k"]);
  });

  it("removing an already-removed person retries the ban without a new change", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "REMOVED", code: "P0011" } });
    const r = await removeMember(admin, "t");
    expect(r.already_removed).toBe(true);
    expect(h.updateUser).toHaveBeenCalledTimes(1);
  });

  it("restore lifts the ban", async () => {
    h.rpc.mockResolvedValue({ data: { member: { id: "t" } }, error: null });
    await restoreMember(admin, "t", null);
    expect(h.updateUser).toHaveBeenCalledWith("t", { ban_duration: "none" });
  });
});

describe("two-step reset", () => {
  it("issues 8 one-time codes, stores only hashes, never the plain codes", async () => {
    h.rpc.mockResolvedValue({ data: {}, error: null });
    const r = await resetMemberMfa(admin, "t");
    expect(r.backup_codes).toHaveLength(8);
    const args = h.rpc.mock.calls[0][1] as { p_backup_hashes: string[]; p_secret_enc: string };
    expect(args.p_backup_hashes).toHaveLength(8);
    for (const c of r.backup_codes) expect(args.p_backup_hashes).not.toContain(c);
    expect(JSON.stringify(args)).not.toContain(r.backup_codes[0]);
  });
  it("a self reset is refused by the database rule", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "SELF_RESET", code: "P0013" } });
    await expect(resetMemberMfa(admin, "a1")).rejects.toMatchObject({ status: 422 });
  });
});

describe("migration 0083 text", () => {
  const sql = readFileSync(join(process.cwd(), "supabase", "migrations", "20261017000083_people_roles_removal.sql"), "utf8")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  it("adds a status instead of deleting profiles", () => {
    expect(sql).toContain("add column if not exists status text not null default 'active'");
    expect(sql).not.toMatch(/delete from profiles/);
  });
  it("locks active admins and refuses to drop the last one", () => {
    expect(sql).toContain("role = 'admin' and status = 'active' order by id for update");
    expect(sql).toContain("'last_admin'");
  });
  it("removal revokes tokens and cancels the invites they sent, with one audit row", () => {
    expect(sql).toContain("update api_tokens set revoked = true");
    expect(sql).toContain("update invites set revoked = true");
    expect(sql).toContain("'member.remove'");
  });
  it("mfa reset notifies the member and audits without secrets", () => {
    expect(sql).toContain("'member.mfa_reset', 'your two-step sign-in was reset'");
    expect(sql).not.toMatch(/'totp_secret'/);
  });
  it("is service-role only", () => {
    expect(sql).toContain("revoke execute on function nopm_member_change");
    expect(sql).toContain("grant execute on function nopm_member_mfa_reset");
  });
});

describe("restore is retryable (R3-4) and removal ends sessions (R3-3)", () => {
  it("member_not_removed on an ACTIVE profile still lifts the ban, with no second RPC change", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "NOT_REMOVED", code: "P0012" } });
    const r = (await restoreMember(admin, "t", null)) as unknown as { already_restored?: boolean };
    expect(r.already_restored).toBe(true);
    expect(h.updateUser).toHaveBeenCalledWith("t", { ban_duration: "none" });
  });
  it("member_not_removed on a profile that is not active is still refused", async () => {
    h.status = "removed";
    h.rpc.mockResolvedValue({ data: null, error: { message: "NOT_REMOVED", code: "P0012" } });
    await expect(restoreMember(admin, "t", null)).rejects.toMatchObject({ code: "member_not_removed" });
    expect(h.updateUser).not.toHaveBeenCalled();
  });
  it("removal bans the login and asks the database to end the person's sessions", async () => {
    h.rpc.mockResolvedValue({ data: { member: { id: "t" } }, error: null });
    await removeMember(admin, "t");
    expect(h.updateUser).toHaveBeenCalledWith("t", expect.objectContaining({ ban_duration: expect.any(String) }));
    expect(h.rpc).toHaveBeenCalledWith("nopm_revoke_user_sessions", { p_user_id: "t" });
  });
  it("a failing session kill never fails the removal", async () => {
    h.rpc.mockImplementation(async (fn: string) =>
      fn === "nopm_revoke_user_sessions" ? Promise.reject(new Error("boom")) : { data: { member: { id: "t" } }, error: null },
    );
    await expect(removeMember(admin, "t")).resolves.toBeTruthy();
  });
});

describe("memberLastSignIns (R-167)", () => {
  const user = (id: string, at: string | null) => ({ id, last_sign_in_at: at });

  it("pages until every wanted id is seen and leaves never-signed-in people out", async () => {
    h.listUsers
      .mockResolvedValueOnce({ data: { users: Array.from({ length: LAST_SIGN_IN_PAGE_SIZE }, (_, i) => user("x" + i, "2026-01-01T00:00:00Z")) }, error: null })
      .mockResolvedValueOnce({ data: { users: [user("a", "2026-10-01T00:00:00Z"), user("b", null)] }, error: null });
    const got = await memberLastSignIns(["a", "b"]);
    expect(h.listUsers).toHaveBeenCalledTimes(2);
    expect(got.get("a")).toBe("2026-10-01T00:00:00Z");
    expect(got.has("b")).toBe(false);
  });

  it("makes no auth call for an empty list", async () => {
    expect((await memberLastSignIns([])).size).toBe(0);
    expect(h.listUsers).not.toHaveBeenCalled();
  });

  it("throws when the page cap is hit with people still unseen, so an empty cell never means 'stopped looking'", async () => {
    h.listUsers.mockResolvedValue({ data: { users: Array.from({ length: LAST_SIGN_IN_PAGE_SIZE }, (_, i) => user("y" + i, null)) }, error: null });
    await expect(memberLastSignIns(["missing"])).rejects.toThrow(/pages/);
    expect(h.listUsers).toHaveBeenCalledTimes(LAST_SIGN_IN_MAX_PAGES);
  });
});
