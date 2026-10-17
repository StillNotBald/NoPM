import { RuleError } from "@/lib/api/errors";

/**
 * Rebaseline lifecycle (red-team R1/M2). The status column used to be recomputed
 * from the votes on EVERY sign-off with no regard for where the rebaseline
 * already was, so a `rejected` rebaseline could be revived by the same approver
 * flipping no_go to go, an `applied` one regressed to `approved` after any later
 * vote and could be applied (and re-snapshot the baselines) again, and a `draft`
 * on an unlocked project could be signed off. The state machine is now explicit
 * and enforced three times: here (clean 422), as a compare-and-set on every
 * status UPDATE in the routes, and by the BEFORE UPDATE trigger in migration
 * 0049 (errcode P0014) — the file mirrors that trigger's allow-list.
 *
 *   draft ──────────► pending_approval ──► approved ──► applied   (terminal)
 *                              └──────────► rejected              (terminal)
 *
 * `draft` is what a rebaseline proposed on an UNLOCKED project starts as (no
 * governed flow applies yet); only a locked project's proposal is born
 * `pending_approval`. Votes are accepted only while `pending_approval`.
 */
export type RebaselineStatus = "draft" | "pending_approval" | "approved" | "applied" | "rejected";

export const REBASELINE_TRANSITIONS: Readonly<Record<RebaselineStatus, readonly RebaselineStatus[]>> = {
  draft: ["pending_approval"],
  pending_approval: ["approved", "rejected"],
  approved: ["applied"],
  applied: [],
  rejected: [],
};

export function isLegalRebaselineTransition(from: string, to: string): boolean {
  if (from === to) return true; // not a transition
  const next = REBASELINE_TRANSITIONS[from as RebaselineStatus];
  return !!next && (next as readonly string[]).includes(to);
}

/** Sign-off is only open while the rebaseline awaits its decision. */
export function assertSignoffOpen(status: string): void {
  if (status !== "pending_approval") {
    throw new RuleError(
      status === "draft"
        ? "This rebaseline is a draft (its project is not locked), so it is not awaiting sign-off."
        : `This rebaseline is already ${status}, so it can no longer be signed off.`,
      "rebaseline_not_pending",
    );
  }
}

/** Only an approved rebaseline can be applied — and only once. */
export function assertApplicable(status: string): void {
  if (status !== "approved") {
    throw new RuleError(
      status === "applied"
        ? "This rebaseline has already been applied."
        : `Rebaseline cannot be applied: status is '${status}', must be 'approved'`,
      status === "applied" ? "already_applied" : "rule_violation",
    );
  }
}

/** The status the votes imply for a rebaseline that is `pending_approval`. */
export function statusFromVotes(votes: readonly { vote: string }[], current: string): string {
  if (votes.some((v) => v.vote === "no_go")) return "rejected";
  const hasGo = votes.some((v) => v.vote === "go");
  const hasPending = votes.some((v) => v.vote === "pending");
  return hasGo && !hasPending ? "approved" : current;
}
