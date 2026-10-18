/**
 * POST /api/invites/accept — restore path: the invite email matches a profile
 * with status 'removed' -> restoreMember (role capped by the inviter's rank),
 * no new auth user, response carries restored: true.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  restoreMember: vi.fn(),
  performInviteAccept: vi.fn(),
  ilike: [] as string[],
  inviterRole: "manager",
  inviteRole: "member",
  inviteEmail: "a_b%c\\d@example.com",
  updateUser: vi.fn(),
  verify: vi.fn(),
  sweep: vi.fn(),
}));

vi.mock("@/lib/people/members", () => ({
  restoreMember: h.restoreMember,
  verifyRemovedMemberPassword: h.verify,
}));
vi.mock("@/lib/governance/invite-accept", () => ({
  performInviteAccept: h.performInviteAccept,
  revokeOtherInvitesForEmail: h.sweep,
}));

function builder(table: string) {
  const state: { filters: string[] } = { filters: [] };
  const b: Record<string, unknown> = {};
  const chain = () => b;
  b.select = chain;
  b.eq = (col: string, val: unknown) => {
    state.filters.push(`${col}=${String(val)}`);
    return b;
  };
  b.is = chain;
  b.limit = chain;
  b.update = chain;
  b.ilike = (_c: string, pattern: string) => {
    h.ilike.push(pattern);
    return b;
  };
  b.maybeSingle = async () => {
    if (table === "invites") {
      return {
        data: {
          id: "inv1",
          workspace_id: "ws1",
          email: h.inviteEmail,
          role: h.inviteRole,
          created_by: "inviter1",
          revoked: false,
          accepted_at: null,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        },
        error: null,
      };
    }
    if (table === "profiles") {
      if (state.filters.includes("status=removed")) return { data: { id: "removed1" }, error: null };
      return { data: { id: "inviter1", role: h.inviterRole, email: "m@example.com", display_name: "M" }, error: null };
    }
    if (table === "workspaces") return { data: { id: "ws1", name: "WS" }, error: null };
    return { data: null, error: null };
  };
  // awaited update(...).eq(...).eq(...).is(...) resolves to { error: null }
  b.then = (resolve: (v: unknown) => void) => resolve({ error: null });
  return b;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ data: { allowed: true, retry_after_seconds: 0 }, error: null }),
    from: (t: string) => builder(t),
    auth: { admin: { updateUserById: h.updateUser } },
  }),
}));

import { POST } from "./route";

function accept() {
  return POST(
    new NextRequest("http://localhost/api/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "npi_x", password: "a-long-enough-password", display_name: "Back Again" }),
    }),
    { params: Promise.resolve({}) },
  );
}

beforeEach(() => {
  h.restoreMember.mockReset().mockResolvedValue(undefined);
  h.performInviteAccept.mockReset();
  h.verify.mockReset().mockResolvedValue(true);
  h.sweep.mockReset().mockResolvedValue([]);
  h.updateUser.mockReset().mockResolvedValue({ error: null });
  h.ilike.length = 0;
  h.inviterRole = "manager";
  h.inviteRole = "member";
});

describe("invites/accept restore path", () => {
  it("restores a removed member with the invited role and answers restored: true", async () => {
    const res = await accept();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.restored).toBe(true);
    expect(h.restoreMember).toHaveBeenCalledTimes(1);
    const [actor, targetId, role] = h.restoreMember.mock.calls[0];
    expect(actor.id).toBe("inviter1");
    expect(targetId).toBe("removed1");
    expect(role).toBe("member");
    expect(h.updateUser).not.toHaveBeenCalled(); // an invite never sets a password
    expect(h.verify).toHaveBeenCalledWith("removed1", h.inviteEmail, "a-long-enough-password");
    expect(h.sweep).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ keepInviteId: "inv1", workspaceId: "ws1" }));
    expect(h.performInviteAccept).not.toHaveBeenCalled();
  });

  it("refuses the restore, changing nothing, when the existing password is not proven (R3-2)", async () => {
    h.verify.mockResolvedValue(false);
    const res = await accept();
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("existing_credentials_required");
    expect(h.restoreMember).not.toHaveBeenCalled();
    expect(h.updateUser).not.toHaveBeenCalled();
    expect(h.sweep).not.toHaveBeenCalled();
  });

  it("refuses when the invited role outranks the inviter (assertRoleWithinCap), restoring nothing", async () => {
    h.inviteRole = "admin";
    const res = await accept();
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("role_escalation");
    expect(h.restoreMember).not.toHaveBeenCalled();
  });

  it("escapes backslash, % and _ in the email before the ILIKE match", async () => {
    await accept();
    expect(h.ilike[0]).toBe("a\\_b\\%c\\\\d@example.com");
  });
});
