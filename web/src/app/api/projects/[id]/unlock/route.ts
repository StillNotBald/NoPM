import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditRpcArgs, throwRebaselineRpcError } from "@/lib/governance/rebaseline-rpc";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { unlockProjectSchema } from "@/app/api/rebaselines/_schema";

export const runtime = "nodejs";

// POST /api/projects/[id]/unlock — unlock project timeline (project:write)
// Body: { reason: string } REQUIRED (R-83 — governed unlock: unlike lock's
// optional reason, unlocking a frozen baseline must always say why).
// Side effect (owner decision 2026-10-17): the project's pending_approval and
// approved rebaselines are cancelled in the same transaction.
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "project:write");

  const db = createAdminClient();

  const { data: before, error: fetchError } = await db
    .from("projects")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!before) throw new NotFoundError("Project not found");

  const body = await safeJson(request);
  const parsed = unlockProjectSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }

  const { reason } = parsed.data;

  // Unlock, void the project's open rebaselines AND write every audit row in ONE
  // transaction (nopm_unlock_project_audited, migration 0062). Owner decision
  // 2026-10-17: a pending or approved rebaseline must never survive an unlock,
  // because the apply step copies the LIVE dates — someone could otherwise
  // unlock, edit the dates, relock, and have an already-approved rebaseline
  // applied on dates its approvers never saw. One function makes it fail-closed:
  // if the cancellation or an audit row cannot be written, the unlock does not
  // stand. Audit rows: one project.unlock + one rebaseline.cancelled per voided
  // rebaseline (the unlock reason lives only in the trail's `after`; lock_reason
  // is nulled on the row). Drafts are left alone: they carry no sign-off.
  const { data: result, error: unlockError } = await db.rpc("nopm_unlock_project_audited", {
    p_project_id: params.id,
    p_workspace_id: actor.workspaceId,
    p_reason: reason,
    ...auditRpcArgs(actor),
  });

  if (unlockError) throwRebaselineRpcError(unlockError, "Failed to unlock the project");

  const { project: after } = result as { project: Record<string, unknown> };

  return ok(after);
});
