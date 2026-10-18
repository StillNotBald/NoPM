import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditRpcArgs, throwRebaselineRpcError } from "@/lib/governance/rebaseline-rpc";
import { requireCanLock } from "@/lib/governance/lock-permissions";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { lockProjectSchema } from "@/app/api/rebaselines/_schema";

export const runtime = "nodejs";

// POST /api/projects/[id]/lock — lock project timeline (project:write)
// Q-GOV-10: a signed-in person needs the manager or admin role; a token needs
// project:write. Q-GOV-9: locking an already locked project changes nothing - the
// first lock keeps its who / when / why - and the reply says already_locked: true.
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "project:write");
  requireCanLock(actor);

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
  const parsed = lockProjectSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }

  // Baseline snapshot, lock and the project.lock audit row are ONE database
  // transaction (nopm_lock_project, migration 0063). The snapshot captures the
  // approved plan dates exactly once (null-only, set-based, so a baseline already
  // set is never overwritten) while the project is still open — once locked the
  // 0028 / 0049 triggers refuse baseline_* writes — and a failure part way
  // leaves nothing half-baselined. An already-locked project has nothing left to
  // freeze, so the snapshot is skipped (unlock and lock again to capture one).
  // The audit row records the project baseline before and after (after.project_baseline).
  const { data: after, error: lockError } = await db.rpc("nopm_lock_project", {
    p_project_id: params.id,
    p_workspace_id: actor.workspaceId,
    p_reason: parsed.data.reason ?? null,
    ...auditRpcArgs(actor),
  });
  if (lockError) throwRebaselineRpcError(lockError, "Failed to lock the project");

  return ok(after as Record<string, unknown>);
});
