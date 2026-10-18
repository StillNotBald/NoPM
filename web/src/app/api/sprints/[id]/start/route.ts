import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { computeSprintSnapshot } from "@/lib/sprints/snapshot";

export const runtime = "nodejs";

/**
 * POST /api/sprints/[id]/start (sprint:write) — governed planned -> active
 * transition. Snapshots EXACTLY what is attached at this instant:
 *   committed_points   = Sigma coalesce(story_points, 0) over attached tasks
 *   committed_snapshot = { task_id: points }
 * Written once, never recomputed by a later story-point edit or task
 * detach (unit-tested in @/lib/sprints/snapshot.test.ts + this route's own
 * behaviour: nothing here re-derives the snapshot after this point).
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
  if (before.state !== "planned") {
    throw new RuleError("Sprint must be planned to start");
  }

  const { data: attachedTasks, error: tasksError } = await db
    .from("tasks")
    .select("id, story_points")
    .eq("workspace_id", actor.workspaceId)
    .eq("sprint_id", params.id);

  if (tasksError) throw tasksError;

  const { points: committedPoints, snapshot: committedSnapshot } = computeSprintSnapshot(
    attachedTasks ?? [],
  );

  const now = new Date().toISOString();
  const { data: after, error: updateError } = await db
    .from("sprints")
    .update({
      state: "active",
      started_at: now,
      committed_points: committedPoints,
      committed_snapshot: committedSnapshot,
      updated_at: now,
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .eq("state", "planned") // race guard: only the winning start actually applies
    .select()
    .maybeSingle();

  if (updateError) throw updateError;
  if (!after) throw new RuleError("Sprint must be planned to start");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "sprint.started",
    targetType: "sprint",
    targetId: params.id,
    before,
    after: { committed_points: committedPoints, task_count: (attachedTasks ?? []).length },
  });

  return ok(after);
});
