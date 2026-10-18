import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { requireApprover } from "@/lib/auth/approver";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { assertNotRequesterPrincipal, requirePrincipal } from "@/lib/governance/decide";
import { assertApplicable } from "@/lib/governance/rebaseline-lifecycle";
import { auditRpcArgs, throwRebaselineRpcError } from "@/lib/governance/rebaseline-rpc";

export const runtime = "nodejs";

// POST /api/rebaselines/[id]/apply — apply an approved rebaseline (rebaseline:approve)
export const POST = route(async ({ actor, params }) => {
  requireScope(actor, "rebaseline:approve");
  // Applying is the checker's act (same scope as sign-off): it needs a human
  // behind the actor, and that human must not be the requester.
  const principal = requirePrincipal(actor);
  requireApprover(actor); // D-16: applying is the checker's act, admins and managers only

  const db = createAdminClient();

  // Load rebaseline — must belong to actor's workspace
  const { data: rebaseline, error: fetchError } = await db
    .from("rebaselines")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!rebaseline) throw new NotFoundError("Rebaseline not found");

  // Four-eyes: the requester may not apply a rebaseline they raised (R-04).
  if (actor.type === "user" && rebaseline.requested_by && actor.id === rebaseline.requested_by) {
    throw new RuleError("Four-eyes: you cannot apply a rebaseline you requested.", "self_approval");
  }
  assertNotRequesterPrincipal(
    rebaseline.requested_principal_id,
    principal,
    "Four-eyes: you cannot apply a rebaseline you requested.",
  );

  // Only approved rebaselines may be applied — and only once (R1/M2: an
  // applied rebaseline used to regress to approved after any later vote and
  // could be applied, and re-snapshot the baselines, again).
  assertApplicable(rebaseline.status);

  // Moving the baselines, approved -> applied and the rebaseline.apply audit row
  // are ONE database transaction (nopm_apply_rebaseline, migration 0062; it wraps
  // nopm_apply_rebaseline_snapshot, which sets the transaction-local
  // nopm.lock_bypass a locked project needs). Before, a failure after the status
  // flip left an applied rebaseline with no audit row and no way to write it.
  // The function also refuses (422 project_not_locked) when the project was
  // unlocked since the sign-off, repeats the approver-role rule (P0018) and
  // records the project baseline either side of the move in the audit row
  // (after.project_baseline) for the History tab and the Trust Center.
  const { data, error } = await db.rpc("nopm_apply_rebaseline", {
    p_rebaseline_id: params.id,
    p_workspace_id: actor.workspaceId,
    p_approver_principal_id: principal,
    ...auditRpcArgs(actor),
  });
  if (error) {
    throwRebaselineRpcError(
      error,
      "Failed to apply the rebaseline",
      new RuleError("This rebaseline has already been applied.", "already_applied"),
    );
  }

  return ok(data as Record<string, unknown>);
});
