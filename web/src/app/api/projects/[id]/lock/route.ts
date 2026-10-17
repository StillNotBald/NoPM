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

  // ── Baseline snapshot ──────────────────────────────────────────────────────
  // Capture the approved plan dates exactly once: only rows where the baseline
  // is still null (i.e. never been baselined).  A subsequent rebaseline.apply
  // will overwrite these with the newly-approved dates.
  //
  // This MUST run while the project is still open. Once is_locked is true the
  // 0028 triggers reject any baseline_* write (PROJECT_LOCKED, P0010) unless
  // nopm.lock_bypass is set — and only the rebaseline snapshot RPC sets it. So
  // the order is snapshot -> lock -> audit: a failure before the lock leaves an
  // open project with some baselines set (a retry finishes the rest, the
  // null-only filter makes it idempotent); locking first used to 500 here and
  // leave a locked project with NO baselines. An already-locked project has
  // nothing left to freeze and the triggers would refuse the write, so it skips
  // the snapshot (unlock and lock again to capture one).
  if (!before.is_locked) {
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

    // The project's own baseline (migration 0055 moves it on every rebaseline
    // apply; this is the first capture). Same null-only rule, one column at a
    // time so a baseline someone already set is never overwritten, and still
    // before is_locked flips — the 0049 trigger freezes these columns after.
    const projectBaseline: Array<[column: string, current: unknown]> = [
      ["baseline_start_date", before.start_date],
      ["baseline_target_date", before.target_date],
    ];
    for (const [column, current] of projectBaseline) {
      if (current == null) continue; // nothing to snapshot
      const { error: projUpdateErr } = await db
        .from("projects")
        .update({ [column]: current })
        .eq("id", params.id)
        .eq("workspace_id", actor.workspaceId)
        .is(column, null);
      if (projUpdateErr) throw projUpdateErr;
    }
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

  // The trail for the project baseline: what it was when the lock was asked for
  // and what the row holds now (read back from the locked row, so it is what was
  // really written). Equal on an already-locked project and on a re-lock.
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "project.lock",
    targetType: "project",
    targetId: params.id,
    before,
    after: {
      ...after,
      project_baseline: {
        before: { start: before.baseline_start_date ?? null, target: before.baseline_target_date ?? null },
        after: { start: after.baseline_start_date ?? null, target: after.baseline_target_date ?? null },
      },
    },
  });

  return ok(after);
});
