import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedUpdate } from "@/lib/audit/audited-write";
import { ok } from "@/lib/api/response";
import { NotFoundError, PreconditionFailedError, RuleError } from "@/lib/api/errors";
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
  // Row and audit row are one transaction (nopm_mutate_audited). Race guard: only
  // the winning start applies. The row is locked and compared on the updated_at
  // read above, so a start that lost the race gets the same 422 as before.
  let after;
  try {
    ({ after } = await auditedUpdate({
      table: "sprints",
      actor,
      action: "sprint.started",
      id: params.id,
      patch: {
        state: "active",
        started_at: now,
        committed_points: committedPoints,
        committed_snapshot: committedSnapshot,
        updated_at: now,
      },
      expectedUpdatedAt: before.updated_at,
      notFoundMessage: "Sprint not found",
      auditAfter: { committed_points: committedPoints, task_count: (attachedTasks ?? []).length },
    }));
  } catch (error) {
    if (error instanceof PreconditionFailedError) throw new RuleError("Sprint must be planned to start");
    throw error;
  }

  return ok(after);
});
