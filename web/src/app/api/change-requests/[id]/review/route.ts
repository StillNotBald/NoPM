import { route } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { requireScope } from "@/lib/auth/guard";
import { requireApprover } from "@/lib/auth/approver";
import { createAdminClient } from "@/lib/supabase/admin";
import { announceChanged, changeRequestEvent, requirePrincipal } from "@/lib/governance/decide";
import { throwTransitionRpcError } from "@/lib/governance/change-transition";
import { auditRpcArgs } from "@/lib/governance/rebaseline-rpc";

export const runtime = "nodejs";

/**
 * POST /api/change-requests/:id/review (Q-GOV-3)
 * A manager or admin moves a RAISED change request to "under review". No body.
 * The status change and its `change_request.start_review` audit row are ONE
 * database transaction (nopm_transition_change_request, migration 0076), which
 * also repeats the manager/admin rule. Scope: change:decide (the approver scope;
 * the assistant and every PAT preset never carry it).
 *   403 role_not_permitted - not a manager or admin
 *   422 invalid_transition - the request is not "raised"
 */
export const POST = route(async ({ actor, params }) => {
  requireScope(actor, "change:decide");
  const principal = requirePrincipal(actor);
  requireApprover(actor);

  const db = createAdminClient();
  const { data, error } = await db.rpc("nopm_transition_change_request", {
    p_id: params.id,
    p_workspace_id: actor.workspaceId,
    p_action: "start_review",
    p_principal_id: principal,
    ...auditRpcArgs(actor),
  });
  if (error) throwTransitionRpcError(error, "start_review");

  const updated = data as Record<string, unknown> & { id: string };
  // The version moved: retire any card that describes the old one (fail-soft).
  try {
    announceChanged(await changeRequestEvent(db, actor.workspaceId, updated as never));
  } catch (err) {
    console.error("[change-requests] could not announce the review start", err);
  }
  return ok(updated);
});
