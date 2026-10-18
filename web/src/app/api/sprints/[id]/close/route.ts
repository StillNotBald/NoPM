import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { closeSprintSchema } from "../../_schema";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";
import { isUnfinished, parseDestination, unfinishedPrompt } from "@/lib/sprints/close";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { auditRpcArgs } from "@/lib/governance/rebaseline-rpc";
import { throwCloseSprintRpcError } from "@/lib/sprints/close-rpc";

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
 *
 * Q-WRK-20: when attached tasks are not finished the caller must say where they
 * go — body `{ "move_unfinished_to": "backlog" | "<sprint id>" }` (another
 * planned/active sprint of the same project). Without it the close is refused
 * (422 `unfinished_tasks`, nothing changes). Finished (completed/canceled)
 * tasks stay attached as the closed sprint's history. The moved task ids are
 * recorded in the single sprint.closed audit row.
 */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "sprint:write");

  // The body is optional (a sprint with no unfinished tasks needs none).
  const raw = await safeJson(request);
  const unknown = unknownFieldsResponse(raw, closeSprintSchema);
  if (unknown) return unknown;
  const parsedBody = closeSprintSchema.safeParse(raw ?? {});
  if (!parsedBody.success) {
    return validationError(
      "Invalid close request",
      parsedBody.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }
  const moveTo = parsedBody.data.move_unfinished_to;

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

  const { data: attachedAll, error: tasksError } = await db
    .from("tasks")
    .select("id, status_type")
    .eq("workspace_id", actor.workspaceId)
    .eq("sprint_id", params.id);

  if (tasksError) throw tasksError;
  const attachedRows = (attachedAll ?? []) as { id: string; status_type: string }[];
  const unfinishedIds = attachedRows.filter((t) => isUnfinished(t.status_type)).map((t) => t.id);

  if (unfinishedIds.length > 0 && !moveTo) {
    throw new RuleError(unfinishedPrompt(unfinishedIds.length), "unfinished_tasks");
  }
  if (unfinishedIds.length > 0 && moveTo) {
    const dest = parseDestination(moveTo);
    if (dest.kind === "sprint") {
      const { data: target, error: targetError } = await db
        .from("sprints")
        .select("id, project_id, state")
        .eq("id", dest.sprintId)
        .eq("workspace_id", actor.workspaceId)
        .maybeSingle();
      if (targetError) throw targetError;
      if (!target || target.id === params.id || target.project_id !== before.project_id || target.state === "closed") {
        throw new RuleError(
          "move_unfinished_to must be \"backlog\" or another planned or active sprint of this project",
          "invalid_destination",
        );
      }
    }
  }

  // One transaction in SQL: state, snapshot, move of the unfinished tasks and the
  // single sprint.closed audit row (R3-7). The tasks are re-read under the lock,
  // so a task attached after the read above is still handled.
  const { data: after, error: closeError } = await db.rpc("nopm_close_sprint", {
    p_sprint_id: params.id,
    p_workspace_id: actor.workspaceId,
    p_move_to: moveTo ?? null,
    ...auditRpcArgs(actor),
  });
  if (closeError) throwCloseSprintRpcError(closeError);

  return ok(after as Record<string, unknown>);
});
