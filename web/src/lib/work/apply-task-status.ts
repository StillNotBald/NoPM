import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "@/lib/auth/guard";
import { buildAuditArg } from "@/lib/audit/audited-write";

/**
 * Move one task to a new status for a non-human caller (a connector work event, R-153), atomically:
 * `nopm_apply_task_status_from_event` (migration 0105) locks the task row and its project row, refuses
 * when the project is locked (writing one `work_event.skipped` audit row instead), refuses when the task
 * changed since it was read (optimistic concurrency, `updated_at`), and otherwise updates the status and
 * writes exactly one `task.update` audit row in the same transaction. A failure leaves neither a changed
 * task nor a missing audit row. The audit row carries the actor's connector provenance (channel `github`,
 * via_connector_id, delivery id, GitHub login).
 *
 * It does not decide WHETHER to move (rules and forward-only ordering are the caller's job) and it never
 * touches schedule-shape fields. The task PATCH route sends no notification for a status move, so none is sent.
 */

export type StatusMoveTask = {
  id: string;
  workspace_id: string;
  updated_at: string;
  status: string | null;
  status_type: string;
} & Record<string, unknown>;

export type StatusMoveResult =
  | { ok: true; updated: Record<string, unknown> }
  | { ok: false; reason: "conflict" | "project_locked" };

export async function applyTaskStatus(args: {
  db: SupabaseClient;
  actor: Actor;
  task: StatusMoveTask;
  statusType: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  /** New free-text label, null to clear it, undefined to leave the existing label alone. */
  statusLabel?: string | null;
  /** Context recorded on a skipped (locked project) audit row. */
  skipContext?: Record<string, unknown>;
}): Promise<StatusMoveResult> {
  const { db, actor, task, statusType, statusLabel } = args;
  const { data, error } = await db.rpc("nopm_apply_task_status_from_event", {
    p_workspace_id: task.workspace_id,
    p_task_id: task.id,
    p_expected_updated_at: task.updated_at,
    p_status_type: statusType,
    p_set_label: statusLabel !== undefined,
    p_status_label: statusLabel ?? null,
    p_audit: buildAuditArg(actor, task.workspace_id, "task.update", "task"),
    p_skip_audit: {
      ...buildAuditArg(actor, task.workspace_id, "work_event.skipped", "task"),
      after: args.skipContext ?? {},
    },
  });
  if (error) throw new Error(error.message);
  const result = (data ?? {}) as { result?: string; after?: Record<string, unknown> };
  if (result.result === "applied" && result.after) return { ok: true, updated: result.after };
  if (result.result === "project_locked") return { ok: false, reason: "project_locked" };
  return { ok: false, reason: "conflict" };
}
