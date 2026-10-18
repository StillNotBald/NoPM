import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok } from "@/lib/api/response";
import { RuleError } from "@/lib/api/errors";
import { actorLabel, announceDecided, requireMakerPrincipal } from "@/lib/governance/decide";
import { rebaselineEvent } from "@/lib/integrations/rebaseline-approval";
import { auditRpcArgs, throwRebaselineRpcError } from "@/lib/governance/rebaseline-rpc";

export const runtime = "nodejs";

/**
 * POST /api/rebaselines/:id/withdraw (Q-GOV-7)
 * The person who proposed a rebaseline withdraws it while it still awaits
 * sign-off (pending_approval -> cancelled), which frees the project for a new
 * proposal. No body. Withdrawing decides nothing, so it is not an approver act:
 * scope project:write (the scope that proposes), and only the proposer (the
 * person behind it, so a token they minted counts) may do it.
 * The status change and its `rebaseline.withdrawn` audit row are ONE database
 * transaction (nopm_withdraw_rebaseline, migration 0076).
 *   403 not_requester          - not the proposer
 *   422 rebaseline_not_pending - already approved, rejected, applied or cancelled
 */
export const POST = route(async ({ actor, params }) => {
  requireScope(actor, "project:write");
  const principal = requireMakerPrincipal(actor);

  const db = createAdminClient();
  const { data, error } = await db.rpc("nopm_withdraw_rebaseline", {
    p_rebaseline_id: params.id,
    p_workspace_id: actor.workspaceId,
    p_principal_id: principal,
    ...auditRpcArgs(actor),
  });
  if (error) {
    throwRebaselineRpcError(
      error,
      "Failed to withdraw the rebaseline",
      new RuleError("This rebaseline is no longer waiting for sign-off, so it cannot be withdrawn.", "rebaseline_not_pending"),
    );
  }

  // Retire the open sign-off cards. After the commit, never fails the request.
  try {
    const row = data as { id: string; project_id: string; version?: number; reason?: string; requested_principal_id?: string; requested_by?: string; after?: unknown };
    const ev = await rebaselineEvent(db, actor.workspaceId, { ...row, status: "cancelled" });
    announceDecided({
      ...ev,
      status: "withdrawn",
      decidedByLabel: actorLabel(actor),
      channel: actor.channel ?? (actor.type === "token" ? "api" : "ui"),
    });
  } catch (err) {
    console.error("[rebaselines] could not announce the withdrawal", err);
  }

  return ok(data as Record<string, unknown>);
});
