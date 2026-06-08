import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok } from "@/lib/api/response";
import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
import { notify } from "@/lib/notify/publish";

export const runtime = "nodejs";

/**
 * POST /api/deletion-requests/[id]/approve
 * Four-eyes checker step: approve and immediately commit the deletion.
 * Requires scope task:delete:approve.
 * Guards:
 *   - Request must be in status 'pending' (else RuleError 422)
 *   - Approver must NOT be the same actor who raised the request (four-eyes, ScopeError 403)
 * Effect:
 *   1. Delete the target row (currently only target_type === 'task')
 *   2. Update the deletion_request: status='committed', approved_by_*, decided_at, committed_at
 *   3. Write audit "task.delete" (before = snapshot captured at request time)
 *   4. Write audit "deletion_request.approved"
 */
export const POST = route(async ({ actor, params }) => {
  requireScope(actor, "task:delete:approve");

  const db = createAdminClient();

  // Load the deletion request (workspace-scoped)
  const { data: request, error: fetchError } = await db
    .from("deletion_requests")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!request) throw new NotFoundError("Deletion request not found");

  // Must still be pending
  if (request.status !== "pending") {
    throw new RuleError("Request already decided");
  }

  // Four-eyes: approver cannot be the same person who requested
  if (actor.id === request.requested_by_id) {
    throw new ScopeError("Self-approval is not allowed (four-eyes)");
  }

  const now = new Date().toISOString();

  // Perform the actual delete (currently only 'task' is supported)
  if (request.target_type === "task") {
    const { error: deleteError } = await db
      .from("tasks")
      .delete()
      .eq("id", request.target_id)
      .eq("workspace_id", actor.workspaceId);

    if (deleteError) throw new Error(deleteError.message);
  }

  // Commit the deletion request
  const { error: updateError } = await db
    .from("deletion_requests")
    .update({
      status: "committed",
      approved_by_type: actor.type,
      approved_by_id: actor.id,
      approved_by_label: actor.label,
      decided_at: now,
      committed_at: now,
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (updateError) throw new Error(updateError.message);

  // Audit 1: the actual deletion of the target resource
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "task.delete",
    targetType: request.target_type,
    targetId: request.target_id,
    before: request.before,
    after: null,
  });

  // Audit 2: the governance step itself
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "deletion_request.approved",
    targetType: "deletion_request",
    targetId: request.id,
    before: { status: "pending" },
    after: { status: "committed" },
  });

  // Notify the original requester — fail-soft
  if (request.requested_by_id) {
    void notify({
      workspaceId: actor.workspaceId,
      recipientIds: [request.requested_by_id],
      type: "approval.approved",
      title: "Your deletion request was approved",
      body: `The deletion of ${request.target_type} has been approved and committed.`,
      payload: { requestId: request.id, targetType: request.target_type, targetId: request.target_id },
    });
  }

  return ok({ committed: true });
});
