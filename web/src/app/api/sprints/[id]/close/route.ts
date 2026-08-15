import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { computeSprintSnapshot } from "@/lib/sprints/snapshot";

export const runtime = "nodejs";

/**
 * POST /api/sprints/[id]/close (sprint:write) — governed active -> closed
 * transition. Snapshots exactly what had reached status_type='completed' by
 * this instant among attached tasks:
 *   completed_points   = Sigma coalesce(story_points, 0) over attached tasks
 *                         whose status_type = 'completed'
 *   completed_snapshot = { task_id: points }
 * Written once, never recomputed afterwards — same invariant as start's
 * committed snapshot.
 */
export const POST = route(async ({ actor, params }) => {
  requireScope(actor, "sprint:write");

  const db = createAdminClient();

  const { data: before, error: fetchError } = await db
    .from("sprints")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!before) throw new NotFoundError("Sprint not found");
  if (before.state !== "active") {
    throw new RuleError("Sprint must be active to close");
  }

  const { data: completedTasks, error: tasksError } = await db
    .from("tasks")
    .select("id, story_points")
    .eq("workspace_id", actor.workspaceId)
    .eq("sprint_id", params.id)
    .eq("status_type", "completed");

  if (tasksError) throw tasksError;

  const { points: completedPoints, snapshot: completedSnapshot } = computeSprintSnapshot(
    completedTasks ?? [],
  );

  const now = new Date().toISOString();
  const { data: after, error: updateError } = await db
    .from("sprints")
    .update({
      state: "closed",
      closed_at: now,
      completed_points: completedPoints,
      completed_snapshot: completedSnapshot,
      updated_at: now,
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .eq("state", "active") // race guard: only the winning close actually applies
    .select()
    .maybeSingle();

  if (updateError) throw updateError;
  if (!after) throw new RuleError("Sprint must be active to close");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "sprint.closed",
    targetType: "sprint",
    targetId: params.id,
    before,
    after,
  });

  return ok(after);
});
