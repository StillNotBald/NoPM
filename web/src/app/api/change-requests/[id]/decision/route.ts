import { route } from "@/lib/api/handler";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { requireScope } from "@/lib/auth/guard";
import { decideChangeRequest } from "@/lib/governance/decide";
import { decisionActionSchema } from "@/app/api/change-requests/_schema";

export const runtime = "nodejs";

/**
 * POST /api/change-requests/:id/decision
 * Four-eyes: record an approve / reject / defer decision on a change request.
 * Guards (all in @/lib/governance/decide):
 *   - Change request must be in status 'raised' or 'under_review' (else
 *     RuleError 422) — and the UPDATE is a compare-and-set on that status, so
 *     two deciders racing can't both succeed
 *   - Deciding actor MUST be a different HUMAN from the requester (ScopeError
 *     403 `self_approval`): compared on the requester's principal (user id, or
 *     the creator of the token that raised it) AND on the legacy requested_by
 *     / actor-typed requested_by_type+requested_by_id columns
 *   - A token with no recorded owner can't decide at all (403 `no_principal`)
 * Effect:
 *   1. Update status → approved | rejected | deferred; set decided_by,
 *      decided_by_label, decided_by_type, decided_by_id, decided_principal_id,
 *      decided_at, decision_rationale
 *   2. writeAudit change_request.decide (before/after)
 *   3. notify requester — fail-soft, type 'approval.approved'
 *
 * Scope: change:decide (split from change:write in R-83 — raising and
 * deciding a change request are different privilege levels; the assistant's
 * scope ceiling and every PAT preset never carry change:decide, and a
 * wildcard such as `change:*` never grants it).
 */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "change:decide");

  const body = await safeJson(request);
  const parsed = decisionActionSchema.safeParse(body);
  if (!parsed.success) {
    return validationError("Validation failed", parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })));
  }

  const { row } = await decideChangeRequest(actor, params.id, parsed.data);

  return ok(row);
});
