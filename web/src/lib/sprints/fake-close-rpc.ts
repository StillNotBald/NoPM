/** In-memory mirror of nopm_close_sprint (migration 0086) for route tests. Test support only. */
import type { FakeDb, RpcResult } from "@/lib/governance/test-support/fake-admin";

const err = (code: string, message: string): RpcResult => ({ data: null, error: { message, code } });

export function closeSprintRpc(args: Record<string, unknown>, db: FakeDb): RpcResult {
  const ws = args.p_workspace_id;
  const sprint = db.rows("sprints").find((s) => s.id === args.p_sprint_id && s.workspace_id === ws);
  if (!sprint) return err("P0002", "NOT_FOUND: sprint not found");
  if (sprint.state !== "active") return err("P0025", "SPRINT_NOT_ACTIVE");
  const before = { ...sprint };
  const attached = db.rows("tasks").filter((t) => t.workspace_id === ws && t.sprint_id === sprint.id);
  const unfinished = attached.filter((t) => t.status_type !== "completed" && t.status_type !== "canceled");
  const done = attached.filter((t) => t.status_type === "completed");
  const moveTo = (args.p_move_to as string | null) ?? null;
  let destId: string | null = null;
  if (unfinished.length > 0) {
    if (moveTo === null) return err("P0026", "UNFINISHED_TASKS");
    if (moveTo !== "backlog") {
      const dest = db.rows("sprints").find((s) => s.id === moveTo && s.workspace_id === ws);
      if (!dest || dest.id === sprint.id || dest.project_id !== sprint.project_id || dest.state === "closed") {
        return err("P0027", "INVALID_DESTINATION");
      }
      destId = dest.id as string;
    }
  }
  const snapshot: Record<string, number> = {};
  let points = 0;
  for (const t of done) {
    const p = Number(t.story_points ?? 0) || 0;
    snapshot[t.id as string] = Math.round(p * 10) / 10;
    points += p;
  }
  Object.assign(sprint, {
    state: "closed",
    closed_at: new Date().toISOString(),
    completed_points: Math.round(points * 10) / 10,
    completed_snapshot: snapshot,
  });
  for (const t of unfinished) t.sprint_id = destId;
  const after = { ...sprint };
  db.rows("audit_log").push({
    workspace_id: ws,
    actor_type: args.p_actor_type,
    actor_id: args.p_actor_id,
    actor_label: args.p_actor_label,
    channel: args.p_channel ?? null,
    id: db.nextId("audit_log"),
    action: "sprint.closed",
    target_type: "sprint",
    target_id: sprint.id,
    before,
    after: unfinished.length > 0 ? { ...after, moved_unfinished: { to: destId ?? "backlog", task_ids: unfinished.map((t) => t.id) } } : after,
  });
  return { data: after, error: null };
}
