import { createHash } from "node:crypto";
import { RuleError, ScopeError } from "@/lib/api/errors";

/**
 * Timesheet four-eyes guard logic (L-31, Template B — recon-foureyes.md).
 * Extracted as pure functions (not inlined in the route) so the guard-
 * symmetry invariant — self-decision is blocked on BOTH approve AND reject —
 * is unit-testable without a live database.
 */

export type TimesheetSubmissionRow = {
  status: string;
  submitted_by: string;
  submitted_by_type: "user" | "token";
};

export type DecisionActor = { id: string; type: "user" | "token" };

export type TimesheetDecision = "approved" | "rejected" | "reopened";

/**
 * Must still be in the decidable state. Terminal statuses (approved/rejected)
 * 422 rather than silently re-deciding. NOT used for "reopened" — that verb
 * has the opposite precondition (see assertReopenable below).
 */
export function assertDecidable(status: string): void {
  if (status !== "submitted") {
    throw new RuleError(`Timesheet submission already decided (status: ${status})`, "already_decided");
  }
}

/**
 * R-76 (L-32): "reopened" is the inverse of assertDecidable — it is only
 * valid on an APPROVED submission (that's the whole point: unlocking an
 * already-approved, and therefore period-locked, week). Reopening a
 * 'submitted' (nothing to reopen — it's already awaiting a decision) or
 * 'rejected' (resubmit instead — a fresh row is created, see
 * assertNoOpenDuplicate) submission 422s.
 */
export function assertReopenable(status: string): void {
  if (status !== "approved") {
    throw new RuleError(
      `Only an approved timesheet submission can be reopened (status: ${status})`,
      "not_reopenable",
    );
  }
}

/**
 * D2 (f2b-specs.md): self-decision -> ScopeError 403 on BOTH approve and
 * reject (guard symmetry — the deletion-request reject route learned this
 * lesson the hard way: a checker-only guard on approve left self-rejection
 * to surface as a raw DB CHECK violation / 500 instead of a clean 403).
 *
 * COMPOUND (id AND type) comparison: actor.id is drawn from two disjoint
 * namespaces (profiles.id for a user session, api_tokens.id for a token
 * caller) — comparing the uuid alone could theoretically collide across
 * namespaces, so submitted_by_type must match too. Mirrors the
 * ts_maker_checker DB CHECK, which is the id-only backstop; this route guard
 * is the stricter, type-aware version (recon-foureyes.md compound-guard note).
 */
export function assertNotSelfDecision(
  submission: TimesheetSubmissionRow,
  actor: DecisionActor,
): void {
  if (submission.submitted_by === actor.id && submission.submitted_by_type === actor.type) {
    throw new ScopeError("Self-approval is not allowed (four-eyes)");
  }
}

/**
 * Rejection AND reopening both require a non-empty rationale (422 if
 * absent/blank) — approval does not. Reopening reverts an already-approved
 * decision, so it carries the same "explain yourself" bar as rejecting one
 * (R-76/L-32); despite the name, this function now gates both verbs.
 */
export function assertRationaleOnReject(
  decision: TimesheetDecision,
  rationale: string | null | undefined,
): void {
  if ((decision === "rejected" || decision === "reopened") && (!rationale || !rationale.trim())) {
    throw new RuleError(
      decision === "reopened"
        ? "A rationale is required when reopening a timesheet submission"
        : "A rationale is required when rejecting a timesheet submission",
      "rationale_required",
    );
  }
}

/** No open (submitted|approved) submission may already exist for this member+period. */
export function assertNoOpenDuplicate(existing: { status: string } | null | undefined): void {
  if (existing) {
    throw new RuleError(
      "An open timesheet submission already exists for this member and period",
      "duplicate_submission",
    );
  }
}

/** At least one time entry must exist in the period to submit (422 "nothing to submit"). */
export function assertHasEntriesToSubmit(entryCount: number): void {
  if (entryCount <= 0) {
    throw new RuleError("Nothing to submit — no time entries in this period", "nothing_to_submit");
  }
}

// ── content binding (red-team R1/H2) ──────────────────────────────────────
//
// An approval used to be bound to nothing: hours_total / entry_count were a
// snapshot taken at submit time and never compared again, so entries added or
// swapped between "submitted" and "approved" were approved unseen (and an
// approver could reopen, edit the member's hours themselves, and re-approve
// against the stale snapshot). Two defences now stack:
//   1. FREEZE — while a sheet is under review (submitted, not reopened) or
//      approved, its week's entries cannot be created or deleted
//      (lib/governance/period-lock.ts + the DB trigger in migration 0049);
//   2. BIND — the submit step records a content digest next to the totals, and
//      the approve step refuses (422 `timesheet_changed`) unless the live
//      entries still match it. Rejecting unlocks the week; the member edits
//      and resubmits a fresh row with a fresh digest.
// The digest catches what totals cannot: swapping an 8h entry for a different
// 8h entry (another project, another day) leaves hours and count unchanged.

/** The time_entries columns the digest covers — select exactly these. */
export const TIMESHEET_ENTRY_COLUMNS = "id, entry_date, hours, project_id, billable";

export type TimesheetEntryRow = {
  id: string;
  entry_date: string;
  hours: number | string | null;
  project_id: string | null;
  billable: boolean | null;
};

/** Whole hundredths — hours are numeric(6,2); comparing cents sidesteps float drift (0.1 + 0.2). */
function cents(value: number | string | null | undefined): number {
  const n = typeof value === "string" ? Number(value) : (value ?? 0);
  return Math.round((Number.isFinite(n) ? n : 0) * 100);
}

/** Totals for the snapshot columns (`hours_total`, `entry_count`). */
export function summariseEntries(entries: readonly Pick<TimesheetEntryRow, "hours">[]): {
  hoursTotal: number;
  entryCount: number;
} {
  const total = entries.reduce((sum, e) => sum + cents(e.hours), 0);
  return { hoursTotal: total / 100, entryCount: entries.length };
}

/**
 * Order-independent SHA-256 of the entries under review. Covers id, day, hours,
 * project and billable — the same columns the DB lock trigger treats as content.
 * (Not task_id / note: deleting a task nulls task_id by design, and that must not
 * invalidate an approved week.)
 */
export function timesheetContentDigest(entries: readonly TimesheetEntryRow[]): string {
  const lines = entries
    .map((e) =>
      [
        String(e.id).toLowerCase(),
        String(e.entry_date).slice(0, 10),
        (cents(e.hours) / 100).toFixed(2),
        e.project_id ?? "",
        e.billable === false ? "0" : "1",
      ].join("|"),
    )
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export const TIMESHEET_CHANGED_MESSAGE =
  "The time entries changed after this timesheet was submitted, so it can no longer be approved as submitted — reject it with a reason and have the member resubmit.";

export type SubmissionSnapshot = {
  hours_total: number | string | null;
  entry_count: number | null;
  /** Null on rows submitted before the digest existed — those fall back to totals only. */
  content_digest?: string | null;
};

/**
 * 422 `timesheet_changed` unless the live entries still match what was
 * submitted: same totals, and (when a digest was recorded) the same content.
 */
export function assertTimesheetContentUnchanged(
  submission: SubmissionSnapshot,
  entries: readonly TimesheetEntryRow[],
): void {
  const live = summariseEntries(entries);
  const totalsMatch =
    cents(submission.hours_total) === cents(live.hoursTotal) && (submission.entry_count ?? 0) === live.entryCount;
  const digestMatches = !submission.content_digest || submission.content_digest === timesheetContentDigest(entries);
  if (!totalsMatch || !digestMatches) {
    throw new RuleError(TIMESHEET_CHANGED_MESSAGE, "timesheet_changed");
  }
}
