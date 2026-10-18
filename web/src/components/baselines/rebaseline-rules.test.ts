import { describe, expect, it } from "vitest";
import { PROPOSER_NOTE, ROLE_NOTE, rebaselineActionsFor } from "./rebaseline-rules";

const base = { viewerId: "me", requestedBy: "other", requestedPrincipalId: "other" };

describe("rebaselineActionsFor", () => {
  it("lets a manager or admin sign off a pending rebaseline someone else proposed", () => {
    for (const viewerRole of ["manager", "admin"]) {
      expect(rebaselineActionsFor({ ...base, status: "pending_approval", viewerRole })).toEqual({
        canSignoff: true,
        canApply: false,
        canWithdraw: false,
        note: null,
      });
    }
  });

  it("offers apply, not sign-off, once approved", () => {
    expect(rebaselineActionsFor({ ...base, status: "approved", viewerRole: "manager" })).toMatchObject({
      canSignoff: false,
      canApply: true,
      canWithdraw: false,
    });
  });

  it("D-16: members and viewers get the role note and no control", () => {
    for (const viewerRole of ["member", "viewer", null]) {
      expect(rebaselineActionsFor({ ...base, status: "pending_approval", viewerRole })).toEqual({
        canSignoff: false,
        canApply: false,
        canWithdraw: false,
        note: ROLE_NOTE,
      });
    }
  });

  it("never the proposer, by user id or by person", () => {
    expect(
      rebaselineActionsFor({ ...base, status: "pending_approval", viewerRole: "admin", requestedBy: "me" }).note,
    ).toBe(PROPOSER_NOTE);
    expect(
      rebaselineActionsFor({ ...base, status: "approved", viewerRole: "admin", requestedPrincipalId: "me" }).canApply,
    ).toBe(false);
  });

  it("offers nothing on a closed rebaseline", () => {
    for (const status of ["draft", "applied", "rejected", "cancelled"]) {
      expect(rebaselineActionsFor({ ...base, status, viewerRole: "admin" })).toEqual({
        canSignoff: false,
        canApply: false,
        canWithdraw: false,
        note: null,
      });
    }
  });
});

describe("Q-GOV-7 withdraw", () => {
  const base = { viewerId: "me", viewerRole: "manager", requestedBy: "me", requestedPrincipalId: "me" };
  it("the proposer may withdraw while it awaits sign-off", () => {
    expect(rebaselineActionsFor({ ...base, status: "pending_approval" }).canWithdraw).toBe(true);
  });
  it("not once it is approved, and not for someone else", () => {
    expect(rebaselineActionsFor({ ...base, status: "approved" }).canWithdraw).toBe(false);
    expect(
      rebaselineActionsFor({ ...base, status: "pending_approval", requestedBy: "x", requestedPrincipalId: "x" }).canWithdraw,
    ).toBe(false);
  });
});
