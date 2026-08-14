import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok } from "@/lib/api/response";
import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";

export const runtime = "nodejs";

/**
 * POST /api/deletion-requests/[id]/withdraw
 * Maker step: withdraw your OWN still-pending deletion request.
 * Requires scope task:delete:request.
 * Only the original requester may withdraw (403 otherwise) — this is the one
 * self-decision four-eyes permits: it cancels the request rather than deciding
 * it, so no approver is recorded (the maker_checker_different CHECK enforces
 * approved_by_id IS NULL for withdrawn rows).
 * Effect:
 *   1. Update the deletion_request: status='withdrawn', decided_at=now
 *   2. Write audit "deletion_request.withdrawn"
 */
export const POST = route(async ({ actor, params }) => {
  requireScope(actor, "task:delete:request");

  const db = createAdminClient();

  // Load the deletion request (workspace-scoped)
  const { data: deletionRequest, error: fetchError } = await db
    .from("deletion_requests")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!deletionRequest) throw new NotFoundError("Deletion request not found");

  if (
    deletionRequest.requested_by_id !== actor.id ||
    deletionRequest.requested_by_type !== actor.type
  ) {
    throw new ScopeError("Only the original requester can withdraw a deletion request");
  }

  if (deletionRequest.status !== "pending") {
    throw new RuleError("Request already decided");
  }

  const { error: updateError } = await db
    .from("deletion_requests")
    .update({ status: "withdrawn", decided_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .eq("status", "pending");

  if (updateError) throw new Error(updateError.message);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "deletion_request.withdrawn",
    targetType: "deletion_request",
    targetId: deletionRequest.id,
    before: { status: "pending" },
    after: { status: "withdrawn" },
  });

  return ok({ withdrawn: true });
});
