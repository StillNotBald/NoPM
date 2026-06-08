import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { lockProjectSchema } from "@/app/api/rebaselines/_schema";

export const runtime = "nodejs";

// POST /api/projects/[id]/lock — lock project timeline (project:write)
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

  const now = new Date().toISOString();

  const { data: after, error: updateError } = await db
    .from("projects")
    .update({
      is_locked: true,
      locked_by: actor.type === "user" ? actor.id : null,
      locked_at: now,
      lock_reason: parsed.data.reason ?? null,
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError) throw updateError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "project.lock",
    targetType: "project",
    targetId: params.id,
    before,
    after,
  });

  // ── Baseline snapshot ──────────────────────────────────────────────────────
  // Capture the approved plan dates exactly once: only rows where the baseline
  // is still null (i.e. never been baselined).  A subsequent rebaseline.apply
  // will overwrite these with the newly-approved dates.

  // Milestones: snapshot target_date → baseline_target_date (null only)
  const { data: milestones, error: msErr } = await db
    .from("milestones")
    .select("id, target_date")
    .eq("project_id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .is("baseline_target_date", null);

  if (msErr) throw msErr;

  if (milestones && milestones.length > 0) {
    for (const ms of milestones) {
      if (ms.target_date == null) continue; // nothing to snapshot
      const { error: msUpdateErr } = await db
        .from("milestones")
        .update({ baseline_target_date: ms.target_date })
        .eq("id", ms.id)
        .eq("workspace_id", actor.workspaceId);
      if (msUpdateErr) throw msUpdateErr;
    }
  }

  // Tasks: snapshot start_date/due_date → baseline_start_date/baseline_due_date (null only)
  const { data: tasks, error: tasksErr } = await db
    .from("tasks")
    .select("id, start_date, due_date")
    .eq("project_id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .is("baseline_start_date", null)
    .is("baseline_due_date", null);

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

  return ok(after);
});
