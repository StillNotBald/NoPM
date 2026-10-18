import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ audit: vi.fn(), ops: [] as string[], rows: [] as unknown[] }));
vi.mock("@/lib/audit/write", () => ({ writeAudit: h.audit }));

import { revokeOtherInvitesForEmail } from "./invite-accept";

function client() {
  const b: Record<string, unknown> = {};
  for (const m of ["update", "eq", "is", "neq"]) {
    b[m] = (...a: unknown[]) => {
      h.ops.push(`${m}:${a.join("=")}`);
      return b;
    };
  }
  b.ilike = (_c: string, p: string) => {
    h.ops.push(`ilike:${p}`);
    return b;
  };
  b.select = async () => ({ data: h.rows, error: null });
  return { from: () => b };
}

beforeEach(() => {
  h.audit.mockReset();
  h.ops.length = 0;
  h.rows = [];
});

describe("revokeOtherInvitesForEmail (R3-2)", () => {
  it("revokes every other open invite for the email in the workspace, one audit row each", async () => {
    h.rows = [
      { id: "i2", email: "a_b@x.com", role: "member" },
      { id: "i3", email: "a_b@x.com", role: "admin" },
    ];
    const ids = await revokeOtherInvitesForEmail(client(), {
      workspaceId: "ws1",
      email: "a_b@x.com",
      keepInviteId: "i1",
      actorId: "p1",
      actorLabel: "a_b@x.com",
    });
    expect(ids).toEqual(["i2", "i3"]);
    expect(h.ops).toContain("neq:id=i1");
    expect(h.ops).toContain("eq:workspace_id=ws1");
    expect(h.ops).toContain("ilike:a\\_b@x.com");
    expect(h.ops).toContain("eq:revoked=false");
    expect(h.ops).toContain("is:accepted_at=");
    expect(h.audit).toHaveBeenCalledTimes(2);
    expect(h.audit.mock.calls[0][0]).toMatchObject({ action: "invite.revoked", targetId: "i2", workspaceId: "ws1" });
  });
  it("does nothing (no audit) when there is nothing else open", async () => {
    expect(
      await revokeOtherInvitesForEmail(client(), { workspaceId: "ws1", email: "a@x.com", keepInviteId: "i1", actorId: "p", actorLabel: "a" }),
    ).toEqual([]);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
