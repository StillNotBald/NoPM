import { route } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { withdrawDeletion } from "@/lib/governance/decide";

export const runtime = "nodejs";

/**
 * POST /api/deletion-requests/[id]/withdraw
 * Maker step: withdraw your OWN still-pending deletion request.
 * Requires the maker scope matching the request's target type
 * (task:delete:request or project:delete:request) — per-type gate.
 * Only the original requester may withdraw (403 otherwise) — this is the one
 * self-decision four-eyes permits: it cancels the request rather than deciding
 * it, so no approver is recorded (the maker_checker_different CHECK enforces
 * approved_by_id IS NULL for withdrawn rows).
 * Effect (in @/lib/governance/decide):
 *   1. Update the deletion_request: status='withdrawn', decided_at=now
 *   2. Write audit "deletion_request.withdrawn"
 */
export const POST = route(async ({ actor, params }) => {
  await withdrawDeletion(actor, params.id);

  return ok({ withdrawn: true });
});
