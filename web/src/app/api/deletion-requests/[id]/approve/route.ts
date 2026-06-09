import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok } from "@/lib/api/response";
import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { notify } from "@/lib/notify/publish";

export const runtime = "nodejs";

/**
 * POST /api/deletion-requests/[id]/approve
 * Four-eyes checker step: approve and immediately commit the deletion.
 * Requires scope task:delete:approve.
 *
 * The delete + request-commit + BOTH audit rows run inside ONE Postgres
 * transaction (the `nopm_commit_task_deletion` function, migration 0020), with
 * the request row locked FOR UPDATE. So a crash can never leave a committed
 * deletion without its audit rows, and two approvers can't double-commit. The
 * function's guards (pending, four-eyes) raise typed errors mapped below.
 */
export const POST = route(async ({ actor, params }) => {
  requireScope(actor, "task:delete:approve");

  const db = createAdminClient();

  const { data, error } = await db.rpc("nopm_commit_task_deletion", {
    p_request_id: params.id,
    p_workspace_id: actor.workspaceId,
    p_approver_type: actor.type,
    p_approver_id: actor.id,
    p_approver_label: actor.label,
  });

  if (error) {
    const m = `${error.message ?? ""} ${error.code ?? ""}`;
    if (m.includes("NOT_FOUND") || error.code === "P0002") throw new NotFoundError("Deletion request not found");
    if (m.includes("ALREADY_DECIDED") || error.code === "P0001") throw new RuleError("Request already decided");
    if (m.includes("SELF_APPROVAL") || error.code === "P0003") throw new ScopeError("Self-approval is not allowed (four-eyes)");
    throw new Error(error.message || "Failed to commit deletion");
  }

  const res = (data ?? {}) as {
    requested_by_id?: string | null;
    target_type?: string;
    target_id?: string;
    request_id?: string;
  };

  // Notify the original requester — fail-soft (outside the transaction by design)
  if (res.requested_by_id) {
    void notify({
      workspaceId: actor.workspaceId,
      recipientIds: [res.requested_by_id],
      type: "approval.approved",
      title: "Your deletion request was approved",
      body: `The deletion of ${res.target_type} has been approved and committed.`,
      payload: { requestId: res.request_id, targetType: res.target_type, targetId: res.target_id },
    });
  }

  return ok({ committed: true });
});
