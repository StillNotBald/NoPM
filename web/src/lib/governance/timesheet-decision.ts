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
