import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";

export const runtime = "nodejs";

// POST /api/rebaselines/[id]/apply — apply an approved rebaseline (project:write)
export const POST = route(async ({ actor, params }) => {
  requireScope(actor, "rebaseline:approve");

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
    throw new RuleError("Four-eyes: you cannot apply a rebaseline you requested.");
  }

  // Only approved rebaselines may be applied
  if (rebaseline.status !== "approved") {
    throw new RuleError(
      `Rebaseline cannot be applied: status is '${rebaseline.status}', must be 'approved'`,
    );
  }

  const now = new Date().toISOString();

  const { data: after, error: updateError } = await db
    .from("rebaselines")
    .update({
      status: "applied",
      applied_at: now,
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError) throw updateError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "rebaseline.apply",
    targetType: "rebaseline",
    targetId: params.id,
    before: rebaseline,
    after,
  });

  // ── Re-baseline snapshot ───────────────────────────────────────────────────
  // When a rebaseline is applied, the newly-approved dates become the new
  // baseline: set baseline_* = current schedule dates for all milestones and
  // tasks in the project.  This overwrites any existing baseline (intentional —
  // the governance trail lives in audit_log, not in the column history).
  //
  // Guard: rebaseline.project_id must exist; if the shape ever changes this
  // block is skipped gracefully so the apply itself is never blocked.
  //
  // Runs as a single RPC (nopm_apply_rebaseline_snapshot, migration 0028)
  // rather than a loop of individual `.update()` calls: this project may be
  // locked (that's the normal case — applying a rebaseline is how a locked
  // project's dates legitimately change), and the DB-level lock backstop
  // (migration 0028) enforces that on every task/milestone write. The RPC
  // sets a transaction-local nopm.lock_bypass at its start, which only holds
  // for the one transaction the RPC call opens — a loop of separate
  // supabase-js calls would each open their own transaction and the bypass
  // would not carry across them.
  const projectId: string | null = rebaseline.project_id ?? null;

  if (projectId) {
    const { error: snapshotErr } = await db.rpc("nopm_apply_rebaseline_snapshot", {
      p_project_id: projectId,
      p_workspace_id: actor.workspaceId,
    });
    if (snapshotErr) throw snapshotErr;
  }

  return ok(after);
});
