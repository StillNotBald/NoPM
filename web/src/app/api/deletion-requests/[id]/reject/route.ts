import { route } from "@/lib/api/handler";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { rejectDeletion } from "@/lib/governance/decide";
import { z } from "zod";

export const runtime = "nodejs";

// Q-GOV-21: a rejection always says why. Enforced in rejectDeletion (422
// rationale_required) after the scope / role / four-eyes checks, on every route.
const RejectSchema = z.object({
  reason: z.string().max(1000).optional(),
});

/**
 * POST /api/deletion-requests/[id]/reject
 * Checker step: reject a pending deletion request.
 * Requires the scope matching the request's target type (task:delete:approve
 * or project:delete:approve) — per-type gate, resolved after loading.
 * Four-eyes applies to BOTH decisions: self-rejection is refused (422 for the
 * same actor, 403 for the same HUMAN through another identity, e.g. a PAT the
 * requester minted), and a token with no recorded owner can't decide at all.
 * Effect (in @/lib/governance/decide):
 *   1. Update the deletion_request: status='rejected', approved_by_* and
 *      approved_principal_id from the actor, decided_at=now (compare-and-set
 *      on status='pending')
 *   2. Write audit "deletion_request.rejected"
 */
export const POST = route(async ({ actor, params, request }) => {
  const body = await safeJson(request);
  const parsed = RejectSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  await rejectDeletion(actor, params.id, { reason: parsed.data.reason });

  return ok({ rejected: true });
});
