import { describe, it, expect, beforeEach, vi } from "vitest";

// The invite sweep against the in-memory mirror of nopm_revoke_other_invites (migration 0109): the guards of the
// old chained update (workspace, e-mail match with the escape, not the kept invite, not revoked, not accepted),
// one invite.revoked row per invite, and all-or-nothing when an audit write is refused. The SQL itself is proved
// on a real database by scripts/local-db/probe-atomic-security.mjs.
const { writeAuditMock } = vi.hoisted(() => ({
  writeAuditMock: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/audit/write", () => ({ writeAudit: writeAuditMock }));

import { FakeDb, WS, OTHER_WS } from "@/lib/integrations/test-support";
import { revokeOtherInvitesForEmail } from "./invite-accept";

let db: FakeDb;
const invite = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  workspace_id: WS,
  email: "a_b@x.com",
  role: "member",
  revoked: false,
  accepted_at: null,
  ...over,
});
const sweep = (over: Record<string, unknown> = {}) =>
  revokeOtherInvitesForEmail(db as never, { workspaceId: WS, email: "a_b@x.com", keepInviteId: "keep", actorId: "p1", actorLabel: "a_b@x.com", channel: "api", ...over } as never);
const revoked = () => db.rows("invites").filter((r) => r.revoked === true).map((r) => r.id);

beforeEach(() => {
  writeAuditMock.mockReset();
  writeAuditMock.mockResolvedValue(undefined);
  db = new FakeDb();
  db.seed("invites", [
    invite("keep"),
    invite("o1", { email: "A_B@x.com" }), // case-insensitive match
    invite("o2", { role: "admin" }),
    invite("literal", { email: "axb@x.com" }), // "_" is a literal, not a wildcard
    invite("done", { accepted_at: "2026-10-01T00:00:00Z" }),
    invite("already", { revoked: true }),
    invite("foreign", { workspace_id: OTHER_WS }),
  ]);
});

describe("revokeOtherInvitesForEmail against the database function mirror", () => {
  it("revokes exactly the other open invites of this e-mail in this workspace, one invite.revoked row each", async () => {
    expect((await sweep()).sort()).toEqual(["o1", "o2"]);
    expect(revoked().sort()).toEqual(["already", "o1", "o2"]);
    expect(writeAuditMock).toHaveBeenCalledTimes(2);
    const c = writeAuditMock.mock.calls.map((x) => x[0]) as { action: string; targetId: string; before: Record<string, unknown>; after: Record<string, unknown>; actor: Record<string, unknown> }[];
    expect(c.map((x) => x.action)).toEqual(["invite.revoked", "invite.revoked"]);
    expect(c.map((x) => x.targetId).sort()).toEqual(["o1", "o2"]);
    expect(c[0].before).toMatchObject({ revoked: false });
    expect(c[0].after).toMatchObject({ revoked: true, reason: "another invite for this email was accepted" });
    expect(c[0].actor).toMatchObject({ id: "p1", principalId: "p1", channel: "api" });
  });

  it("does nothing, and audits nothing, when there is nothing else open", async () => {
    expect(await sweep({ email: "nobody@x.com" })).toEqual([]);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("is all-or-nothing: when one audit row cannot be written no invite stays revoked", async () => {
    writeAuditMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("audit down"));
    await expect(sweep()).rejects.toMatchObject({ message: "audit down" });
    expect(revoked()).toEqual(["already"]);
  });

  it("refuses a bad audit description the way the helper does (invalid action name / missing actor)", async () => {
    const realRpc = db.rpc.bind(db);
    const run = async (audit: Record<string, unknown>) =>
      realRpc("nopm_revoke_other_invites", { p_workspace_id: WS, p_email: "a_b@x.com", p_keep_invite_id: "keep", p_audit: audit });
    const good = { action: "invite.revoked", target_type: "invite", actor_type: "user", actor_id: "p1", actor_label: "x", channel: "api" };
    for (const bad of [
      { ...good, action: "Not A Valid Action" },
      { ...good, actor_type: "robot" },
      { ...good, actor_label: "" },
      { ...good, actor_id: null },
      { ...good, channel: "fax" },
      { ...good, target_type: "" },
    ]) {
      const r = await run(bad);
      expect(r.error, JSON.stringify(bad)).not.toBeNull();
      expect(revoked()).toEqual(["already"]); // nothing kept
    }
    expect((await run(good)).error).toBeNull();
  });
});
