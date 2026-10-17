import { describe, expect, it } from "vitest";
import { evaluateDecision, requesterOf, type PendingKind } from "./pending";
import { judgeDecision, type Viewer } from "./four-eyes";

const ME = "user-me";
const OTHER = "user-other";
const viewer: Viewer = { id: ME, role: "member" };

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

  it("refuses a request raised by the viewer's OWN token (a token counts as its creator) — and cannot withdraw it from a session", () => {
    const row = deletion({ requested_by_type: "token", requested_by_id: "tok-1", requested_principal_id: ME });
    expect(judgeDecision({ viewer, kind: "project_deletion", row })).toEqual({
      canDecide: false,
      block: "your_token_raised",
      canWithdraw: false,
    });
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

  it("a viewer-role session cannot decide anything, whoever raised it", () => {
    expect(judgeDecision({ viewer: { id: ME, role: "viewer" }, kind: "task_deletion", row: deletion() })).toEqual({
      canDecide: false,
      block: "no_scope",
      canWithdraw: false,
    });
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

describe("judgeDecision — timesheets", () => {
  const sheet = (over: Record<string, unknown> = {}) => ({
    submitted_by: OTHER,
    submitted_by_type: "user",
    submitted_principal_id: OTHER,
    ...over,
  });

  it("refuses the submitter", () => {
    const row = sheet({ submitted_by: ME, submitted_principal_id: ME });
    expect(judgeDecision({ viewer, kind: "timesheet", row })).toMatchObject({ canDecide: false, block: "you_raised" });
  });

  it("refuses the person whose hours these are, even when someone else submitted them", () => {
    expect(judgeDecision({ viewer, kind: "timesheet", row: sheet(), subjectProfileId: ME })).toEqual({
      canDecide: false,
      block: "your_hours",
      canWithdraw: false,
    });
  });

  it("lets a third person decide", () => {
    expect(judgeDecision({ viewer, kind: "timesheet", row: sheet(), subjectProfileId: "someone-else" }).canDecide).toBe(true);
  });
});

describe("judgeDecision agrees with the agent-facing evaluateDecision (same verdict, never a button the API refuses)", () => {
  const kinds: PendingKind[] = ["task_deletion", "project_deletion", "change_request", "timesheet"];
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
          const row =
            kind === "timesheet"
              ? { submitted_by: r.requested_by_id, submitted_by_type: r.requested_by_type, submitted_principal_id: r.requested_principal_id }
              : r;
          const requester = requesterOf({ kind, row });
          if (!requester.principal && requester.type === "user") requester.principal = requester.id;
          const expected = evaluateDecision({
            actor: { type: "user", id: ME },
            actorPrincipal: ME,
            requester,
            scopeProblem: role === "viewer" ? "Viewers have read-only access" : null,
          });
          const got = judgeDecision({ viewer: { id: ME, role }, kind, row });
          expect(got.canDecide).toBe(expected.can_decide);
          expect(got.block === null).toBe(expected.can_decide);
        });
      }
    }
  }
});
