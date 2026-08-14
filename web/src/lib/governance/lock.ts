import type { SupabaseClient } from "@supabase/supabase-js";
import { NotFoundError, RuleError } from "@/lib/api/errors";

/**
 * Project-lock (baseline freeze) application-layer guard.
 *
 * Locking a project (POST /api/projects/[id]/lock) freezes its *schedule
 * shape* — dates, estimates, milestone/project assignment — while leaving
 * day-to-day work (status, checklist, assignment, priority, ...) fully
 * live. Enforcement lives here, in the data/API layer, per the constitution:
 * governance is invisible in the operational flow, never UI-only.
 */

export type ProjectLockRow = {
  id: string;
  is_locked: boolean | null;
  lock_reason: string | null;
};

/**
 * Fields on a task whose change reshapes the schedule/baseline. A task PATCH
 * is only guarded under lock when it touches one of these; everything else
 * (status, checklist, assignee, priority, ...) stays live under a lock.
 */
export const SCHEDULE_SHAPE_TASK_FIELDS = [
  "start_date",
  "due_date",
  "baseline_start_date",
  "baseline_due_date",
  "estimate_hours",
  "milestone_id",
  "project_id",
] as const;

/**
 * Fields on a milestone whose change reshapes the schedule/baseline.
 * See SCHEDULE_SHAPE_TASK_FIELDS.
 */
export const SCHEDULE_SHAPE_MILESTONE_FIELDS = [
  "start_date",
  "target_date",
  "baseline_target_date",
] as const;

/**
 * Loads a project's lock state (scoped to workspaceId) and throws a
 * RuleError (422, code "project_locked") if it is locked. Returns the
 * project's id/is_locked/lock_reason otherwise.
 *
 * `onBlocked`, if given, is invoked (and awaited) right before the throw —
 * callers use it to write the fail-soft blocked-attempt audit row. Any
 * error it raises is swallowed here so a broken audit write never masks
 * the governance rejection or, worse, lets the mutation through.
 */
export async function assertProjectUnlocked(
  db: SupabaseClient,
  projectId: string,
  workspaceId: string,
  onBlocked?: () => Promise<void>,
): Promise<ProjectLockRow> {
  const { data: project, error } = await db
    .from("projects")
    .select("id, is_locked, lock_reason")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!project) throw new NotFoundError("Project not found");

  if (project.is_locked) {
    if (onBlocked) {
      try {
        await onBlocked();
      } catch {
        // fail-soft: a blocked-attempt audit row must never affect the response.
      }
    }
    throw new RuleError(
      "Project is locked (baseline frozen) — ask an admin to unlock it or apply a rebaseline.",
      "project_locked",
    );
  }

  return project as ProjectLockRow;
}

/**
 * True if `input` touches any of `fields` — used to decide whether a PATCH
 * body counts as a schedule-shape change (and must therefore be guarded
 * under a project lock) or is entirely status/metadata (never guarded).
 */
export function touchesScheduleShape(
  input: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return Object.keys(input).some((key) => fields.includes(key));
}
