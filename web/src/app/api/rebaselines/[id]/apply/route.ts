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
  const projectId: string | null = rebaseline.project_id ?? null;

  if (projectId) {
    // Milestones: set baseline_target_date = current target_date
    const { data: milestones, error: msErr } = await db
      .from("milestones")
      .select("id, target_date")
      .eq("project_id", projectId)
      .eq("workspace_id", actor.workspaceId);

    if (msErr) throw msErr;

    if (milestones && milestones.length > 0) {
      for (const ms of milestones) {
        if (ms.target_date == null) continue;
        const { error: msUpdateErr } = await db
          .from("milestones")
          .update({ baseline_target_date: ms.target_date })
          .eq("id", ms.id)
          .eq("workspace_id", actor.workspaceId);
        if (msUpdateErr) throw msUpdateErr;
      }
    }

    // Tasks: set baseline_start_date/baseline_due_date = current start_date/due_date
    const { data: tasks, error: tasksErr } = await db
      .from("tasks")
      .select("id, start_date, due_date")
      .eq("project_id", projectId)
      .eq("workspace_id", actor.workspaceId);

    if (tasksErr) throw tasksErr;

    if (tasks && tasks.length > 0) {
      for (const task of tasks) {
        if (task.start_date == null && task.due_date == null) continue;
        const { error: taskUpdateErr } = await db
          .from("tasks")
          .update({
            baseline_start_date: task.start_date ?? null,
            baseline_due_date: task.due_date ?? null,
          })
          .eq("id", task.id)
          .eq("workspace_id", actor.workspaceId);
        if (taskUpdateErr) throw taskUpdateErr;
      }
    }
  }

  return ok(after);
});
