import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok } from "@/lib/api/response";
import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { notify } from "@/lib/notify/publish";
import {
  resolveDeletionApproveScope,
  resolveDeletionCommitRpc,
} from "@/lib/governance/deletion-dispatch";

export const runtime = "nodejs";

/**
 * POST /api/deletion-requests/[id]/approve
 * Four-eyes checker step: approve and immediately commit the deletion.
 * Requires the scope matching the request's target type — task:delete:approve
 * for tasks, project:delete:approve for projects (per-type gate, resolved
 * AFTER loading the request; a wrong-type approver gets 403, not a commit).
 *
 * Dispatches by the loaded request's target_type (devops-wave1b, U2) to the
 * matching per-entity atomic commit RPC — see
 * @/lib/governance/deletion-dispatch for why this is a lookup table of
 * dedicated sibling RPCs rather than one generalized function.
 *
 * The delete + request-commit + BOTH audit rows still run inside ONE Postgres
 * transaction *inside the RPC itself* (nopm_commit_task_deletion / migration
 * 0020, nopm_commit_project_deletion / migration 0032), with the request row
 * locked FOR UPDATE there. So a crash can never leave a committed deletion
 * without its audit rows, and two approvers can't double-commit — the
 * pre-fetch below is only to learn target_type for dispatch; the RPC
 * re-validates pending/four-eyes itself under its own lock, so the mapped
 * errors below still apply even if this row changed between the fetch and
 * the RPC call.
 *
 * If the target's project was locked after the deletion was requested, the
 * DB-level lock backstop (migration 0028, and — for a project deletion
 * itself — the is_locked check inside migration 0032) raises PROJECT_LOCKED
 * (errcode P0010) inside the same transaction and the whole commit rolls
 * back — mapped below to a 422 RuleError. Deliberately no bypass for this
 * path: a commit against a since-locked project must fail loudly, not go
 * through silently.
 */
export const POST = route(async ({ actor, params }) => {
  const db = createAdminClient();

  // Load the request first (workspace-scoped) to learn target_type — the RPC
  // itself re-fetches under FOR UPDATE, so this is dispatch-only, not the
  // source of truth for the four-eyes/pending guards.
  const { data: deletionRequest, error: loadError } = await db
    .from("deletion_requests")
    .select("id, target_type")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (loadError) throw new Error(loadError.message);
  if (!deletionRequest) throw new NotFoundError("Deletion request not found");

  // Per-type scope gate — task:delete:approve does NOT grant project approval
  requireScope(actor, resolveDeletionApproveScope(deletionRequest.target_type));

  const rpcName = resolveDeletionCommitRpc(deletionRequest.target_type);

  const { data, error } = await db.rpc(rpcName, {
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
    if (m.includes("PROJECT_LOCKED") || error.code === "P0010")
      throw new RuleError("Project is locked — unlock or rebaseline before committing this deletion.");
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
