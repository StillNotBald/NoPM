import { route } from "@/lib/api/handler";
import { ok } from "@/lib/api/response";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { announceRequested, changeRequestEvent, requireMakerPrincipal } from "@/lib/governance/decide";
import { throwTransitionRpcError } from "@/lib/governance/change-transition";
import { auditRpcArgs } from "@/lib/governance/rebaseline-rpc";

export const runtime = "nodejs";

/**
 * POST /api/change-requests/:id/reopen (owner decision 24, Q-GOV-1)
 * "Defer" parks a change request instead of closing it: the requester (or the
 * token they minted), or a manager or admin, reopens a DEFERRED request to
 * "under review". No body. The earlier defer decision is cleared from the row and
 * kept in the audit row's `before`; the request then needs a fresh decision from a
 * different person, and approvers get a fresh approval card.
 * The status change and its `change_request.reopen` audit row are ONE database
 * transaction (nopm_transition_change_request, migration 0076).
 * Scope: change:write.
 *   403 not_requester      - neither the requester nor a manager/admin
 *   422 invalid_transition - the request is not "deferred"
 */
export const POST = route(async ({ actor, params }) => {
  requireScope(actor, "change:write");
  const principal = requireMakerPrincipal(actor);

  const db = createAdminClient();
  const { data, error } = await db.rpc("nopm_transition_change_request", {
    p_id: params.id,
    p_workspace_id: actor.workspaceId,
    p_action: "reopen",
    p_principal_id: principal,
    ...auditRpcArgs(actor),
  });
  if (error) throwTransitionRpcError(error, "reopen");

  const updated = data as Record<string, unknown> & { id: string };
  try {
    announceRequested(await changeRequestEvent(db, actor.workspaceId, updated as never));
  } catch (err) {
    console.error("[change-requests] could not announce the reopened request", err);
  }
  return ok(updated);
});
