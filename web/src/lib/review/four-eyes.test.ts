import { describe, expect, it } from "vitest";
import { evaluateDecision, requesterOf, type PendingKind } from "./pending";
import { canEditChangeRequest, judgeDecision, judgeRebaselineSignoff, type Viewer } from "./four-eyes";

const ME = "user-me";
const OTHER = "user-other";
const viewer: Viewer = { id: ME, role: "manager" };

const deletion = (over: Record<string, unknown> = {}) => ({
  requested_by_type: "user",
  requested_by_id: OTHER,
  requested_principal_id: OTHER,
  ...over,
});

describe("judgeDecision — deletion requests", () => {
  it("lets a different person decide", () => {
    expect(judgeDecision({ viewer, kind: "task_deletion", row: deletion() })).toEqual({
      canDecide: true,
      block: null,
      canWithdraw: false,
    });
  });

  it("refuses the person who raised it, and lets them withdraw it", () => {
    const row = deletion({ requested_by_id: ME, requested_principal_id: ME });
    expect(judgeDecision({ viewer, kind: "task_deletion", row })).toEqual({
      canDecide: false,
      block: "you_raised",
      canWithdraw: true,
    });
  });

  it("refuses a request raised by the viewer's OWN token (a token counts as its creator) — but lets them withdraw it", () => {
    const row = deletion({ requested_by_type: "token", requested_by_id: "tok-1", requested_principal_id: ME });
    expect(judgeDecision({ viewer, kind: "project_deletion", row })).toEqual({
      canDecide: false,
      block: "your_token_raised",
      canWithdraw: true,
    });
  });

  it("does not offer withdraw for someone else's token request, or a legacy token row with no recorded principal", () => {
    const theirs = deletion({ requested_by_type: "token", requested_by_id: "tok-9", requested_principal_id: OTHER });
    expect(judgeDecision({ viewer, kind: "task_deletion", row: theirs }).canWithdraw).toBe(false);
    const legacy = deletion({ requested_by_type: "token", requested_by_id: "tok-9", requested_principal_id: null });
    expect(judgeDecision({ viewer, kind: "task_deletion", row: legacy }).canWithdraw).toBe(false);
  });

  it("lets the viewer decide a request raised by someone else's token", () => {
    const row = deletion({ requested_by_type: "token", requested_by_id: "tok-9", requested_principal_id: OTHER });
    expect(judgeDecision({ viewer, kind: "task_deletion", row }).canDecide).toBe(true);
  });

  it("cannot compare a legacy token row with no recorded principal, so it passes — as the decision route does", () => {
    const row = deletion({ requested_by_type: "token", requested_by_id: "tok-9", requested_principal_id: null });
    expect(judgeDecision({ viewer, kind: "task_deletion", row }).canDecide).toBe(true);
  });

  it("falls back to the user id when a pre-migration row has no principal column", () => {
    const row = { requested_by_type: "user", requested_by_id: ME };
    expect(judgeDecision({ viewer, kind: "task_deletion", row })).toMatchObject({
      canDecide: false,
      block: "you_raised",
    });
  });

  it("D-16: members and viewers cannot decide anything, whoever raised it", () => {
    for (const role of ["member", "viewer"]) {
      expect(judgeDecision({ viewer: { id: ME, role }, kind: "task_deletion", row: deletion() })).toEqual({
        canDecide: false,
        block: "role_not_permitted",
        canWithdraw: false,
      });
    }
  });

  it("D-16: a member may still withdraw their own deletion request", () => {
    const own = { requested_by_type: "user", requested_by_id: ME, requested_principal_id: ME };
    expect(judgeDecision({ viewer: { id: ME, role: "member" }, kind: "task_deletion", row: own })).toMatchObject({
      canDecide: false,
      canWithdraw: true,
    });
  });

  it("D17: a deletion in a locked project is not offered for approval", () => {
    expect(judgeDecision({ viewer, kind: "task_deletion", row: deletion(), projectLocked: true })).toMatchObject({
      canDecide: false,
      block: "project_locked",
    });
    expect(judgeDecision({ viewer, kind: "project_deletion", row: deletion(), projectLocked: false }).canDecide).toBe(true);
  });

  it("Q-GOV-17: only the requester edits an open change request", () => {
    expect(canEditChangeRequest({ viewerId: ME, status: "raised", requestedPrincipalId: ME })).toBe(true);
    expect(canEditChangeRequest({ viewerId: ME, status: "raised", requestedPrincipalId: OTHER })).toBe(false);
    expect(canEditChangeRequest({ viewerId: ME, status: "approved", requestedPrincipalId: ME })).toBe(false);
  });

  it("D1: rebaseline sign-off is admin/manager only and never the proposer", () => {
    expect(judgeRebaselineSignoff({ id: ME, role: "member" }, {}).block).toBe("role_not_permitted");
    expect(judgeRebaselineSignoff(viewer, { requested_principal_id: ME }).block).toBe("you_raised");
    expect(judgeRebaselineSignoff(viewer, { requested_principal_id: OTHER }).canDecide).toBe(true);
  });
});

describe("judgeDecision — change requests", () => {
  it("compares the legacy profile-id requested_by", () => {
    const mine = { requested_by: ME, requested_by_type: null, requested_by_id: null };
    expect(judgeDecision({ viewer, kind: "change_request", row: mine })).toMatchObject({
      canDecide: false,
      block: "you_raised",
    });
    expect(judgeDecision({ viewer, kind: "change_request", row: { requested_by: OTHER } }).canDecide).toBe(true);
  });

  it("compares the stored principal for a token-raised request", () => {
    const row = {
      requested_by: null,
      requested_by_type: "token",
      requested_by_id: "tok-1",
      requested_principal_id: ME,
    };
    expect(judgeDecision({ viewer, kind: "change_request", row })).toMatchObject({
      canDecide: false,
      block: "your_token_raised",
    });
  });

  it("never offers withdraw (change requests have no withdraw verb)", () => {
    expect(judgeDecision({ viewer, kind: "change_request", row: { requested_by: ME } }).canWithdraw).toBe(false);
  });
});

describe("judgeDecision agrees with the agent-facing evaluateDecision (same verdict, never a button the API refuses)", () => {
  const kinds: PendingKind[] = ["task_deletion", "project_deletion", "change_request"];
  const requesters = [
    { requested_by_type: "user", requested_by_id: ME, requested_principal_id: ME },
    { requested_by_type: "user", requested_by_id: OTHER, requested_principal_id: OTHER },
    { requested_by_type: "token", requested_by_id: "tok-1", requested_principal_id: ME },
    { requested_by_type: "token", requested_by_id: "tok-2", requested_principal_id: OTHER },
    { requested_by_type: "token", requested_by_id: "tok-3", requested_principal_id: null },
  ];

  for (const kind of kinds) {
    for (const role of ["member", "manager", "admin", "viewer"]) {
      for (const [i, r] of requesters.entries()) {
        it(`${kind} / ${role} / requester #${i}`, () => {
          const row = r;
          const requester = requesterOf({ kind, row });
          if (!requester.principal && requester.type === "user") requester.principal = requester.id;
          const expected = evaluateDecision({
            actor: { type: "user", id: ME },
            actorPrincipal: ME,
            requester,
            scopeProblem: role === "viewer" ? "Viewers have read-only access" : null,
          });
          const got = judgeDecision({ viewer: { id: ME, role }, kind, row });
          // D-16: the role gate sits on top of the shared four-eyes verdict.
          const roleOk = role === "admin" || role === "manager";
          expect(got.canDecide).toBe(roleOk && expected.can_decide);
          expect(got.block === null).toBe(roleOk && expected.can_decide);
        });
      }
    }
  }
});
