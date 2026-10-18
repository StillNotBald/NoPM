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
 * Fields on the PROJECT row itself whose change reshapes the schedule/baseline.
 * A project PATCH is only guarded under lock when it actually changes one of
 * these (see changedScheduleShapeFields) — name, owner, RAG, commentary and the
 * rest stay live. Mirrors the WHEN clause of the projects backstop trigger in
 * migration 0049, column for column. (Red-team R1/H1: these used to be freely
 * rewritable on a locked project by one holder of project:write, with no
 * rebaseline and no four-eyes.)
 */
export const SCHEDULE_SHAPE_PROJECT_FIELDS = [
  "start_date",
  "target_date",
  "baseline_start_date",
  "baseline_target_date",
] as const;

/**
 * How a schedule-shape column compares. The DB triggers (0028 / 0049) use
 * `is distinct from` on the typed column, so the API must compare the same way:
 * a date by its calendar day, a numeric by value (12.50 = 12.5), an id by its
 * whole string (truncating a uuid to ten characters would call two different
 * milestones the same).
 */
export type ScheduleFieldKind = "date" | "number" | "id";

/** Every entry of the three SCHEDULE_SHAPE_*_FIELDS lists must be classified here (lock.test.ts enforces it). */
export const SCHEDULE_FIELD_KIND: Readonly<Record<string, ScheduleFieldKind>> = {
  start_date: "date",
  due_date: "date",
  target_date: "date",
  baseline_start_date: "date",
  baseline_due_date: "date",
  baseline_target_date: "date",
  estimate_hours: "number",
  milestone_id: "id",
  project_id: "id",
};

/** null, undefined and "" are all "no value" — the DB stores them all as NULL. */
function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/** True when `a` and `b` are the same stored value for a column of `kind`. */
function sameScheduleValue(kind: ScheduleFieldKind | undefined, a: unknown, b: unknown): boolean {
  const aEmpty = isEmptyValue(a);
  const bEmpty = isEmptyValue(b);
  if (aEmpty || bEmpty) return aEmpty && bEmpty;
  switch (kind) {
    case "date":
      // "2027-01-01" and "2027-01-01T00:00:00Z" are the same day.
      return String(a).slice(0, 10) === String(b).slice(0, 10);
    case "number": {
      const na = Number(a);
      const nb = Number(b);
      // A non-numeric value never equals a stored number: let validation or the DB reject it.
      return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
    }
    default:
      return String(a) === String(b);
  }
}

/**
 * The subset of `fields` that `input` would actually CHANGE on `current`.
 *
 * A PATCH that echoes the stored value back (a form that re-sends the whole
 * record) is not a change and must not trip the lock; only a different value
 * does. A key absent from `input` is untouched; null and undefined count as the
 * same "no value". Each field compares by its own kind (see SCHEDULE_FIELD_KIND).
 */
export function changedScheduleShapeFields(
  input: Record<string, unknown>,
  current: Record<string, unknown>,
  fields: readonly string[],
): string[] {
  return fields.filter(
    (field) =>
      Object.prototype.hasOwnProperty.call(input, field) &&
      input[field] !== undefined &&
      !sameScheduleValue(SCHEDULE_FIELD_KIND[field], input[field], current[field]),
  );
}

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
      "Project is locked (baseline frozen) — ask a manager or admin to unlock it, or propose a rebaseline.",
      "project_locked",
    );
  }

  return project as ProjectLockRow;
}

/**
 * True if `input` touches any of `fields` — used to decide whether a PATCH
 * body counts as a schedule-shape change (and must therefore be guarded
 * under a project lock) or is entirely status/metadata (never guarded).
 *
 * Key presence only — a field echoed back with its stored value still counts.
 * The task, milestone and project routes use changedScheduleShapeFields, which
 * compares values the way the DB triggers do; this is the coarser check.
 */
export function touchesScheduleShape(
  input: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return Object.keys(input).some((key) => fields.includes(key));
}
