/**
 * Status-aging (L-23) — "days in current status", derived from the audit
 * trail rather than a stored counter, so it can never drift from what the
 * governance log actually recorded.
 *
 * Kanban moves persist via `PATCH /api/tasks/[id]` (see
 * `src/app/api/tasks/[id]/route.ts`), which writes exactly one
 * `audit_log` row per update: action `"task.update"`, `before`/`after` are
 * the FULL task row (not a diff). A move is any such row where
 * `before.status_type !== after.status_type` — plenty of `task.update`
 * rows are unrelated edits (rename, reassign, checklist tick) and must be
 * ignored here.
 *
 * The DB-touching half (`fetchTaskStatusAges`) issues exactly ONE query per
 * page — batched across every task id via `.in("target_id", ids)` against
 * the `(target_type, target_id)` composite index from
 * `20260608000006_governance.sql` — never one query per row.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface TaskForStatusAge {
  id: string;
  /** ISO timestamp — used as the age anchor when the task has never transitioned. */
  created_at: string;
}

export interface AuditRowForStatusAge {
  target_id: string | null;
  before: unknown;
  after: unknown;
  /** ISO timestamp of the audit row. */
  created_at: string;
}

export interface StatusAge {
  /** Whole days between the anchor timestamp and `now`, never negative. */
  days: number;
  /** "status_change" when a real status_type transition was found; "created" otherwise. */
  since: "status_change" | "created";
  /** ISO timestamp of the anchor this age was measured from. */
  changedAt: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function statusTypeOf(row: unknown): string | undefined {
  if (row && typeof row === "object" && "status_type" in row) {
    const v = (row as Record<string, unknown>).status_type;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

/**
 * Pure derivation — no I/O. Given a task list and a batch of `task.update`
 * audit rows (any task ids, any order, may include rows for tasks not in
 * `tasks`), returns the most-recent real status_type transition per task,
 * falling back to `created_at` for tasks that were never moved.
 */
export function deriveStatusAges(
  tasks: readonly TaskForStatusAge[],
  auditRows: readonly AuditRowForStatusAge[],
  now: Date = new Date(),
): Map<string, StatusAge> {
  // Most-recent genuine status_type change per task id.
  const lastChangeByTask = new Map<string, string>();

  for (const row of auditRows) {
    if (!row.target_id) continue;
    const beforeStatus = statusTypeOf(row.before);
    const afterStatus = statusTypeOf(row.after);
    // Skip rows that don't carry a status_type on both sides, or where
    // status_type is present but unchanged (a non-status edit).
    if (beforeStatus === undefined || afterStatus === undefined) continue;
    if (beforeStatus === afterStatus) continue;

    const existing = lastChangeByTask.get(row.target_id);
    if (!existing || new Date(row.created_at).getTime() > new Date(existing).getTime()) {
      lastChangeByTask.set(row.target_id, row.created_at);
    }
  }

  const result = new Map<string, StatusAge>();
  const nowMs = now.getTime();

  for (const task of tasks) {
    const changedAt = lastChangeByTask.get(task.id);
    const anchor = changedAt ?? task.created_at;
    const since: StatusAge["since"] = changedAt ? "status_change" : "created";
    const anchorMs = new Date(anchor).getTime();
    const days = Number.isFinite(anchorMs) ? Math.max(0, Math.floor((nowMs - anchorMs) / DAY_MS)) : 0;
    result.set(task.id, { days, since, changedAt: anchor });
  }

  return result;
}

/**
 * DEFAULT threshold (days) past which a task's status age is styled as
 * distinctly stale in the UI (kanban card / tasks page). Since R-141 the real
 * value is the workspace setting `workspaces.stale_days` (this is its default
 * and the fallback when the setting cannot be read).
 */
export const STALE_STATUS_AGE_DAYS = 14;

/** True when a status age is past the threshold (the workspace's, else the default). */
export function isStaleAge(days: number | null | undefined, threshold: number = STALE_STATUS_AGE_DAYS): boolean {
  return typeof days === "number" && days > threshold;
}

/**
 * The workspace's stale threshold (R-141). Fail-soft like the rest of this
 * file: an unreadable setting, or a database without migration 0096, gives the
 * default so the kanban flag and the nudge step never disagree about "stale".
 */
export async function fetchWorkspaceStaleDays(db: SupabaseClient, workspaceId: string): Promise<number> {
  try {
    const { data, error } = await db.from("workspaces").select("stale_days").eq("id", workspaceId).maybeSingle();
    if (error) return STALE_STATUS_AGE_DAYS;
    const v = (data as { stale_days?: unknown } | null)?.stale_days;
    return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 365 ? v : STALE_STATUS_AGE_DAYS;
  } catch {
    return STALE_STATUS_AGE_DAYS;
  }
}

/**
 * DB-touching half: fetch every `task.update` audit row for the given task
 * ids in ONE query, then derive ages purely. Fail-soft — a read-only
 * insight falls back to "since created" for every task rather than
 * breaking the page render (this writes nothing, so fail-closed audit
 * discipline does not apply).
 */
export async function fetchTaskStatusAges(
  db: SupabaseClient,
  tasks: readonly TaskForStatusAge[],
  now: Date = new Date(),
): Promise<Map<string, StatusAge>> {
  const ids = tasks.map((t) => t.id);
  if (ids.length === 0) return new Map();

  const { data, error } = await db
    .from("audit_log")
    .select("target_id, before, after, created_at")
    .eq("target_type", "task")
    .eq("action", "task.update")
    .in("target_id", ids);

  if (error) {
    return deriveStatusAges(tasks, [], now);
  }

  return deriveStatusAges(tasks, (data ?? []) as AuditRowForStatusAge[], now);
}
