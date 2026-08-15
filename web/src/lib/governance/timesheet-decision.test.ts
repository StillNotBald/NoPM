import { describe, it, expect } from "vitest";
import { ScopeError, RuleError } from "@/lib/api/errors";
import {
  assertDecidable,
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
