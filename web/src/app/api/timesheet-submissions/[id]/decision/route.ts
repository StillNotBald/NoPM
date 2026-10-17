import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { decideTimesheet } from "@/lib/governance/decide";
import { timesheetDecisionSchema } from "../../_schema";

export const runtime = "nodejs";

/**
 * POST /api/timesheet-submissions/:id/decision
 * Four-eyes (L-31, Template B): record an approve/reject/reopen decision on
 * a timesheet submission. "reopened" (R-76/L-32) is the governed unlock
 * verb for the period-close lock — it reverts an approved (and therefore
 * locked, per migration 20260815000040) week back to 'submitted' so time
 * entries can be created/deleted in it again.
 *
 * Thin wrapper over decideTimesheet (@/lib/governance/decide). Guards (D2,
 * f2b-specs.md; extended R-76 for reopen; principal-aware since 0045):
 *   - approve/reject: submission must be in status 'submitted' (else 422)
 *   - reopen: submission must be in status 'approved' (else 422) — the INVERSE precondition
 *   - ALL THREE verbs: the deciding actor must be a different HUMAN from the
 *     submitter (ScopeError 403, guard symmetry). Compared on the submitter's
 *     principal (user id, or the creator of the submitting token) plus the
 *     legacy compound (id AND type) check — so a person can't submit in the
 *     console and approve with a PAT they minted. A token with no recorded
 *     owner can't decide at all (403 `no_principal`).
 *   - reject AND reopen require a non-empty rationale (RuleError 422); approve does not
 *   - the status transition is a compare-and-set, so two deciders can't both win
 * Effect:
 *   - approve/reject: status -> approved | rejected; decided_by/_type/_label,
 *     decided_principal_id, decided_at, decision_rationale set
 *   - reopen: status -> submitted; every decided_* column and the rationale NULLed
 *     (ts_maker_checker is CHECK-safe: 'submitted' is the non-terminal exempt status)
 *   - writeAudit timesheet.approved | timesheet.rejected | timesheet.reopened (fail-closed)
 *   - notify — fail-soft: approve/reject notify the submitter's human; reopen
 *     notifies the workspace's approvers (the sheet re-enters the Review Queue)
 */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "time:approve");

  const body = await safeJson(request);
  const parsed = timesheetDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const { row } = await decideTimesheet(actor, params.id, parsed.data);

  return ok(row);
});
