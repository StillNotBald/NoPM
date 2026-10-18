import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { sprintTaskAttachSchema } from "../../_schema";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";

export const runtime = "nodejs";

/**
 * POST /api/sprints/[id]/tasks — attach a task to this sprint (sprint:write).
 * The task must exist in this workspace AND already belong to the sprint's
 * own project (a sprint never spans projects) — otherwise 422 (rule
 * violation, not 404 — the sprint id in the URL was valid, the *combination*
 * with this task_id is not). A closed sprint rejects every attach (its
 * committed_snapshot is frozen history at that point).
 */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "sprint:write");

  const db = createAdminClient();

  const { data: sprint, error: sprintError } = await db
    .from("sprints")
    .select("id, project_id, state, committed_snapshot")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (sprintError) throw sprintError;
  if (!sprint) throw new NotFoundError("Sprint not found");
  if (sprint.state === "closed") {
    throw new RuleError("Cannot attach tasks to a closed sprint");
  }

  const body = await safeJson(request);
  const unknown = unknownFieldsResponse(body, sprintTaskAttachSchema);
  if (unknown) return unknown;
  const parsed = sprintTaskAttachSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid attach request",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const { data: task, error: taskError } = await db
    .from("tasks")
    .select("id, project_id, sprint_id")
    .eq("id", parsed.data.task_id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (taskError) throw taskError;
  if (!task || task.project_id !== sprint.project_id) {
    throw new RuleError("Task must exist in this workspace and belong to the sprint's project");
  }

  // D-WRK-14: a task sitting in a closed sprint is frozen history; attaching it
  // elsewhere would silently steal it from that sprint.
  if (task.sprint_id && task.sprint_id !== sprint.id) {
    const { data: current } = await db
      .from("sprints")
      .select("state")
      .eq("id", task.sprint_id)
      .eq("workspace_id", actor.workspaceId)
      .maybeSingle();
    if (current?.state === "closed") {
      throw new RuleError("This task belongs to a closed sprint and cannot be moved to another sprint");
    }
  }

  const { data: updatedTask, error: attachError } = await db
    .from("tasks")
    .update({ sprint_id: sprint.id })
    .eq("id", task.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (attachError) throw attachError;

  // Q-WRK-20: a task added after the sprint started was not part of the
  // commitment — mark it scope-added in the trail (the console derives the same
  // mark from committed_snapshot).
  const scopeAdded =
    sprint.state === "active" &&
    !Object.prototype.hasOwnProperty.call((sprint.committed_snapshot ?? {}) as Record<string, number>, task.id);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "sprint.task_added",
    targetType: "sprint",
    targetId: sprint.id,
    before: null,
    after: scopeAdded ? { task_id: task.id, scope_added: true } : { task_id: task.id },
  });

  return ok(updatedTask);
});

/**
 * DELETE /api/sprints/[id]/tasks?task_id=<uuid> — detach a task from this
 * sprint (sprint:write). The task must exist in this workspace AND currently
 * be attached to THIS sprint — otherwise 422. A closed sprint rejects every
 * detach too (its snapshot is frozen; the task set at close time is history).
 */
export const DELETE = route(async ({ actor, params, request }) => {
  requireScope(actor, "sprint:write");

  const db = createAdminClient();

  const { data: sprint, error: sprintError } = await db
    .from("sprints")
    .select("id, state")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (sprintError) throw sprintError;
  if (!sprint) throw new NotFoundError("Sprint not found");
  if (sprint.state === "closed") {
    throw new RuleError("Cannot detach tasks from a closed sprint");
  }

  const url = new URL(request.url);
  const taskId = url.searchParams.get("task_id");
  if (!taskId) {
    return validationError("Missing task_id", [
      { field: "task_id", message: "task_id query param is required" },
    ]);
  }

  const { data: task, error: taskError } = await db
    .from("tasks")
    .select("id, sprint_id")
    .eq("id", taskId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (taskError) throw taskError;
  if (!task || task.sprint_id !== sprint.id) {
    throw new RuleError("Task is not attached to this sprint");
  }

  const { data: updatedTask, error: detachError } = await db
    .from("tasks")
    .update({ sprint_id: null })
    .eq("id", task.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (detachError) throw detachError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "sprint.task_removed",
    targetType: "sprint",
    targetId: sprint.id,
    before: null,
    after: { task_id: task.id },
  });

  return ok(updatedTask);
});
