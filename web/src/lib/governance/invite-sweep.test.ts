import { describe, it, expect, beforeEach } from "vitest";
import { revokeOtherInvitesForEmail } from "./invite-accept";

// The sweep is ONE database function (nopm_revoke_other_invites, migration 0109, R-164c): it revokes every other
// open invite for the e-mail and writes one invite.revoked row per invite in the same transaction. The ilike
// escape, the accepted_at / revoked guards and the one-row-per-invite audit are proved against a real database by
// scripts/local-db/probe-atomic-security.mjs; this file proves what the TypeScript side sends and returns.
const h: { calls: { fn: string; args: Record<string, any> }[]; reply: { data: unknown; error: { message: string } | null } } = { // eslint-disable-line @typescript-eslint/no-explicit-any
  calls: [],
  reply: { data: [], error: null },
};

const client = () => ({
  rpc: async (fn: string, args: Record<string, unknown>) => {
    h.calls.push({ fn, args });
    return h.reply;
  },
});

beforeEach(() => {
  h.calls.length = 0;
  h.reply = { data: [], error: null };
});

const base = { workspaceId: "ws1", email: "a_b@x.com", keepInviteId: "i1", actorId: "p1", actorLabel: "a_b@x.com" };

describe("revokeOtherInvitesForEmail (R3-2, R-164c)", () => {
  it("sends the whole sweep to one database function and returns the revoked ids", async () => {
    h.reply = { data: ["i2", "i3"], error: null };
    const ids = await revokeOtherInvitesForEmail(client(), { ...base, channel: "api", requestId: "req-1" });
    expect(ids).toEqual(["i2", "i3"]);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].fn).toBe("nopm_revoke_other_invites");
    expect(h.calls[0].args).toMatchObject({ p_workspace_id: "ws1", p_email: "a_b@x.com", p_keep_invite_id: "i1" });
  });

  it("describes the audit row as invite.revoked by the accepting person, with channel and request id", async () => {
    await revokeOtherInvitesForEmail(client(), { ...base, channel: "api", requestId: "req-1" });
    const audit = h.calls[0].args.p_audit;
    expect(audit).toMatchObject({
      action: "invite.revoked",
      target_type: "invite",
      actor_type: "user",
      actor_id: "p1",
      actor_label: "a_b@x.com",
      principal_id: "p1",
      channel: "api",
      request_id: "req-1",
    });
  });

  it("does nothing and returns [] when there is nothing else open", async () => {
    expect(await revokeOtherInvitesForEmail(client(), base)).toEqual([]);
  });

  it("throws when the database function fails, so no half-done sweep is reported as done", async () => {
    h.reply = { data: null, error: { message: "audit down" } };
    await expect(revokeOtherInvitesForEmail(client(), base)).rejects.toMatchObject({ message: "audit down" });
  });
});
