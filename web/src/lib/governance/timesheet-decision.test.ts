import { describe, it, expect } from "vitest";
import { ScopeError, RuleError } from "@/lib/api/errors";
import {
  assertDecidable,
  assertReopenable,
  assertNotSelfDecision,
  assertRationaleOnReject,
  assertNoOpenDuplicate,
  assertHasEntriesToSubmit,
  type TimesheetSubmissionRow,
} from "./timesheet-decision";

const SUBMITTER = { id: "11111111-1111-4111-8111-111111111111", type: "user" as const };
const APPROVER = { id: "22222222-2222-4222-8222-222222222222", type: "user" as const };

function submission(overrides: Partial<TimesheetSubmissionRow> = {}): TimesheetSubmissionRow {
  return {
    status: "submitted",
    submitted_by: SUBMITTER.id,
    submitted_by_type: SUBMITTER.type,
    ...overrides,
  };
}

describe("assertDecidable", () => {
  it("passes for status='submitted'", () => {
    expect(() => assertDecidable("submitted")).not.toThrow();
  });

  it("422s (RuleError) once already approved", () => {
    expect(() => assertDecidable("approved")).toThrow(RuleError);
  });

  it("422s (RuleError) once already rejected", () => {
    expect(() => assertDecidable("rejected")).toThrow(RuleError);
  });
});

describe("assertReopenable (R-76/L-32)", () => {
  it("passes for status='approved'", () => {
    expect(() => assertReopenable("approved")).not.toThrow();
  });

  it("422s (RuleError) when trying to reopen a 'submitted' submission", () => {
    expect(() => assertReopenable("submitted")).toThrow(RuleError);
  });

  it("422s (RuleError) when trying to reopen a 'rejected' submission", () => {
    expect(() => assertReopenable("rejected")).toThrow(RuleError);
  });

  it("is the inverse precondition of assertDecidable — the same status never passes both", () => {
    for (const status of ["submitted", "approved", "rejected"]) {
      const decidableOk = (() => {
        try {
          assertDecidable(status);
          return true;
        } catch {
          return false;
        }
      })();
      const reopenableOk = (() => {
        try {
          assertReopenable(status);
          return true;
        } catch {
          return false;
        }
      })();
      expect(decidableOk && reopenableOk).toBe(false);
    }
  });
});

describe("assertNotSelfDecision — guard symmetry (D2)", () => {
  it("allows a different user to decide", () => {
    expect(() => assertNotSelfDecision(submission(), APPROVER)).not.toThrow();
  });

  it("blocks the SUBMITTER from approving their own timesheet (403 ScopeError)", () => {
    expect(() => assertNotSelfDecision(submission(), SUBMITTER)).toThrow(ScopeError);
  });

  it("blocks the SUBMITTER from rejecting their own timesheet too — symmetry, not just approve (403 ScopeError)", () => {
    // The guard function itself doesn't branch on decision verb — the route
    // calls it identically before both approve and reject. Verifying the
    // same input throws for the same reason regardless of caller intent is
    // exactly the guard-symmetry property (recon-foureyes.md's lesson: a
    // checker-only guard on approve left self-reject to hit a raw DB 500).
    expect(() => assertNotSelfDecision(submission(), SUBMITTER)).toThrow(
      "Self-approval is not allowed (four-eyes)",
    );
  });

  it("blocks the SUBMITTER from reopening their own approved timesheet too — guard symmetry across ALL THREE decision verbs (403 ScopeError)", () => {
    // Same guard, same call site pattern, now exercised for 'reopened' too —
    // the mini-wave spec's explicit "guard symmetry across ALL decision
    // verbs" requirement (mini-wave-specs.md T1).
    const approvedSubmission = submission({ status: "approved" });
    expect(() => assertNotSelfDecision(approvedSubmission, SUBMITTER)).toThrow(ScopeError);
  });

  it("COMPOUND guard: same id but a DIFFERENT actor type is not a self-decision", () => {
    // submitted_by_type='user' but a token happens to share the same uuid —
    // the compound (id AND type) comparison must not false-block this.
    const tokenActor = { id: SUBMITTER.id, type: "token" as const };
    expect(() => assertNotSelfDecision(submission(), tokenActor)).not.toThrow();
  });

  it("COMPOUND guard: matching id AND matching type IS a self-decision", () => {
    const tokenSubmission = submission({ submitted_by_type: "token" });
    const tokenActor = { id: SUBMITTER.id, type: "token" as const };
    expect(() => assertNotSelfDecision(tokenSubmission, tokenActor)).toThrow(ScopeError);
  });
});

describe("assertRationaleOnReject", () => {
  it("does not require rationale on approve", () => {
    expect(() => assertRationaleOnReject("approved", undefined)).not.toThrow();
  });

  it("422s (RuleError) on reject with no rationale", () => {
    expect(() => assertRationaleOnReject("rejected", undefined)).toThrow(RuleError);
  });

  it("422s (RuleError) on reject with a blank/whitespace-only rationale", () => {
    expect(() => assertRationaleOnReject("rejected", "   ")).toThrow(RuleError);
  });

  it("passes on reject with a non-empty rationale", () => {
    expect(() => assertRationaleOnReject("rejected", "Hours look inflated")).not.toThrow();
  });

  it("422s (RuleError) on reopen with no rationale — same bar as reject (R-76/L-32)", () => {
    expect(() => assertRationaleOnReject("reopened", undefined)).toThrow(RuleError);
  });

  it("422s (RuleError) on reopen with a blank/whitespace-only rationale", () => {
    expect(() => assertRationaleOnReject("reopened", "   ")).toThrow(RuleError);
  });

  it("passes on reopen with a non-empty rationale", () => {
    expect(() => assertRationaleOnReject("reopened", "Entry for Tuesday was wrong, needs correcting")).not.toThrow();
  });

  it("reopen's error message is distinct from reject's", () => {
    expect(() => assertRationaleOnReject("reopened", undefined)).toThrow(
      "A rationale is required when reopening a timesheet submission",
    );
  });
});

describe("assertNoOpenDuplicate", () => {
  it("passes when no existing open submission", () => {
    expect(() => assertNoOpenDuplicate(null)).not.toThrow();
    expect(() => assertNoOpenDuplicate(undefined)).not.toThrow();
  });

  it("422s (RuleError) when an open submission already exists", () => {
    expect(() => assertNoOpenDuplicate({ status: "submitted" })).toThrow(RuleError);
  });
});

describe("assertHasEntriesToSubmit", () => {
  it("passes with at least one entry", () => {
    expect(() => assertHasEntriesToSubmit(1)).not.toThrow();
  });

  it("422s (RuleError) with zero entries", () => {
    expect(() => assertHasEntriesToSubmit(0)).toThrow(RuleError);
  });
});
