import { describe, it, expect } from "vitest";
import { ScopeError, RuleError } from "@/lib/api/errors";
import {
  assertDecidable,
  assertReopenable,
  assertNotSelfDecision,
  assertRationaleOnReject,
  assertNoOpenDuplicate,
  assertHasEntriesToSubmit,
  assertTimesheetContentUnchanged,
  summariseEntries,
  timesheetContentDigest,
  type TimesheetEntryRow,
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

// ── R1/H2: an approval is bound to the content that was submitted ─────────

const entry = (over: Partial<TimesheetEntryRow> = {}): TimesheetEntryRow => ({
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  entry_date: "2026-10-13",
  hours: 8,
  project_id: "bbbbbbbb-0000-4000-8000-000000000001",
  billable: true,
  ...over,
});

const week = (): TimesheetEntryRow[] => [
  entry(),
  entry({ id: "aaaaaaaa-0000-4000-8000-000000000002", entry_date: "2026-10-14", hours: 6.5 }),
];

describe("summariseEntries", () => {
  it("sums in whole hundredths, so 0.1 + 0.2 is 0.3 and not 0.30000000000000004", () => {
    expect(summariseEntries([{ hours: 0.1 }, { hours: 0.2 }])).toEqual({ hoursTotal: 0.3, entryCount: 2 });
  });

  it("reads numeric strings (PostgREST returns numeric as text) and tolerates nulls", () => {
    expect(summariseEntries([{ hours: "8.00" }, { hours: "6.50" }, { hours: null }])).toEqual({ hoursTotal: 14.5, entryCount: 3 });
  });
});

describe("timesheetContentDigest", () => {
  it("is stable and independent of row order", () => {
    expect(timesheetContentDigest(week())).toBe(timesheetContentDigest([...week()].reverse()));
    expect(timesheetContentDigest(week())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats '8' and '8.00' as the same hours", () => {
    expect(timesheetContentDigest([entry({ hours: 8 })])).toBe(timesheetContentDigest([entry({ hours: "8.00" })]));
  });

  it("changes when ANY covered column changes: day, hours, project, billable, or the entry itself", () => {
    const base = timesheetContentDigest(week());
    const variants: Partial<TimesheetEntryRow>[] = [
      { entry_date: "2026-10-15" },
      { hours: 7 },
      { project_id: "bbbbbbbb-0000-4000-8000-000000000002" },
      { billable: false },
      { id: "aaaaaaaa-0000-4000-8000-0000000000ff" },
    ];
    for (const v of variants) {
      expect(timesheetContentDigest([entry(v), week()[1]]), JSON.stringify(v)).not.toBe(base);
    }
  });

  it("ignores a task link: deleting a task nulls task_id and must not invalidate an approved week", () => {
    const withTask = { ...entry(), task_id: "cccccccc-0000-4000-8000-000000000001" } as TimesheetEntryRow;
    expect(timesheetContentDigest([withTask])).toBe(timesheetContentDigest([entry()]));
  });
});

describe("assertTimesheetContentUnchanged", () => {
  const submitted = () => {
    const entries = week();
    return {
      snapshot: { hours_total: "14.50", entry_count: 2, content_digest: timesheetContentDigest(entries) },
      entries,
    };
  };

  it("passes when the live entries are exactly what was submitted", () => {
    const { snapshot, entries } = submitted();
    expect(() => assertTimesheetContentUnchanged(snapshot, entries)).not.toThrow();
  });

  it("422 timesheet_changed when an entry was ADDED after submission (the 8h -> 48h case)", () => {
    const { snapshot, entries } = submitted();
    const err = (() => {
      try {
        assertTimesheetContentUnchanged(snapshot, [...entries, entry({ id: "aaaaaaaa-0000-4000-8000-000000000003", hours: 40 })]);
      } catch (e) {
        return e as RuleError;
      }
    })();
    expect(err).toBeInstanceOf(RuleError);
    expect([err?.status, err?.code]).toEqual([422, "timesheet_changed"]);
  });

  it("422 when an entry was REMOVED", () => {
    const { snapshot, entries } = submitted();
    expect(() => assertTimesheetContentUnchanged(snapshot, entries.slice(1))).toThrow(RuleError);
  });

  it("422 on a SWAP that totals cannot see: same hours, same count, different project", () => {
    const { snapshot, entries } = submitted();
    const swapped = [entry({ project_id: "bbbbbbbb-0000-4000-8000-000000000009" }), entries[1]];
    expect(summariseEntries(swapped)).toEqual(summariseEntries(entries));
    expect(() => assertTimesheetContentUnchanged(snapshot, swapped)).toThrow(RuleError);
  });

  it("a legacy row with no digest falls back to the totals check", () => {
    const { entries } = submitted();
    const legacy = { hours_total: 14.5, entry_count: 2, content_digest: null };
    expect(() => assertTimesheetContentUnchanged(legacy, entries)).not.toThrow();
    expect(() => assertTimesheetContentUnchanged(legacy, [...entries, entry({ id: "aaaaaaaa-0000-4000-8000-000000000003" })])).toThrow(
      RuleError,
    );
  });
});
