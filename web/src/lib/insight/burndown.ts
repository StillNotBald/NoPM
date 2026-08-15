/**
 * Sprint burndown (L-19) — pure derivation of a daily remaining-points
 * series from `sprint.started_at` through `min(today, sprint.end_date)`.
 *
 * Source of truth for "what's committed": `sprint.committed_snapshot`, the
 * `{ task_id: points }` map frozen at POST /api/sprints/{id}/start (D8,
 * lib/sprints/snapshot.ts). Burndown NEVER re-derives commitment from the
 * task table's current story_points — a later story-point edit or a task
 * detach must not move the committed line (same invariant the snapshot
 * itself is unit-tested for at the API layer). `attachedTasks` is accepted
 * only as a defensive fallback (see below), never as the primary source.
 *
 * A task counts as "burned down" on day D when the LATEST transition to
 * status_type 'completed' at-or-before end-of-day(D) is also its most
 * recent transition overall as of that instant — i.e. we track the running
 * "current status as of day D" per committed task from the ordered
 * `task.update` audit trail, so a later un-complete transition correctly
 * re-adds the task's points to `remaining` on subsequent days.
 *
 * The ideal line runs committed -> 0 linearly across the WORKING days
 * (Mon-Fri) of the sprint's full [start_date, end_date] window — weekends
 * never move it. Design choice (undocumented upstream, so fixed here):
 * `ideal(day) = committed * (1 - workingDaysElapsedThroughDay / totalWorkingDays)`,
 * where "elapsed through day" counts every working day from the sprint's
 * start date up to and including `day` (weekend days don't advance the
 * count, so the line is flat across them).
 */

import { computeSprintSnapshot, type SnapshotSourceTask } from "@/lib/sprints/snapshot";

export interface SprintForBurndown {
  /** ISO timestamp — null/undefined means the sprint never started (no burndown yet). */
  started_at: string | null | undefined;
  /** Plain YYYY-MM-DD date column. */
  end_date: string;
  committed_points: number | string | null | undefined;
  /** `{ task_id: points }` frozen at start — the committed set. */
  committed_snapshot: Record<string, number> | null | undefined;
}

export type TaskForBurndown = SnapshotSourceTask;

export interface AuditRowForBurndown {
  target_id: string | null;
  before: unknown;
  after: unknown;
  /** ISO timestamp of the audit row. */
  created_at: string;
}

export interface BurndownPoint {
  /** YYYY-MM-DD */
  date: string;
  remaining: number;
  ideal: number;
}

export interface BurndownSeries {
  points: BurndownPoint[];
}

function statusTypeOf(row: unknown): string | undefined {
  if (row && typeof row === "object" && "status_type" in row) {
    const v = (row as Record<string, unknown>).status_type;
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

function safeNumber(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return toDateOnly(d);
}

function endOfDayMs(dateStr: string): number {
  return new Date(`${dateStr}T23:59:59.999Z`).getTime();
}

function isWeekday(dateStr: string): boolean {
  const day = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

function enumerateDates(startStr: string, endStr: string): string[] {
  if (startStr > endStr) return [];
  const result: string[] = [];
  let cursor = startStr;
  // Sprints are weeks, not years — this loop is bounded in practice.
  while (cursor <= endStr) {
    result.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return result;
}

/**
 * Pure derivation — no I/O. `attachedTasks` is used ONLY as a fallback when
 * `sprint.committed_snapshot` is missing entirely (defensive against a
 * corrupted/never-set snapshot on an active sprint) — when present, the
 * frozen snapshot is always authoritative per D8.
 */
export function deriveBurndown(
  sprint: SprintForBurndown,
  attachedTasks: readonly TaskForBurndown[],
  auditRows: readonly AuditRowForBurndown[],
  today: Date = new Date(),
): BurndownSeries {
  if (!sprint.started_at) return { points: [] };

  const committedSnapshot =
    sprint.committed_snapshot ?? computeSprintSnapshot([...attachedTasks]).snapshot;
  const committedTaskIds = Object.keys(committedSnapshot);
  const committedPoints = round1(
    committedTaskIds.reduce((sum, id) => sum + safeNumber(committedSnapshot[id]), 0),
  );

  const startDateStr = toDateOnly(new Date(sprint.started_at));
  const todayStr = toDateOnly(today);
  const boundStr = todayStr < sprint.end_date ? todayStr : sprint.end_date;
  const lastDateStr = boundStr < startDateStr ? startDateStr : boundStr;

  // Ordered per-task transitions, restricted to committed tasks + genuine
  // status_type changes (mirrors deriveStatusAges' before/after guard).
  const transitionsByTask = new Map<string, { at: number; status: string }[]>();
  const committedIdSet = new Set(committedTaskIds);
  for (const row of auditRows) {
    if (!row.target_id || !committedIdSet.has(row.target_id)) continue;
    const afterStatus = statusTypeOf(row.after);
    const beforeStatus = statusTypeOf(row.before);
    if (afterStatus === undefined) continue;
    if (beforeStatus !== undefined && beforeStatus === afterStatus) continue;
    const at = new Date(row.created_at).getTime();
    if (!Number.isFinite(at)) continue;
    const list = transitionsByTask.get(row.target_id) ?? [];
    list.push({ at, status: afterStatus });
    transitionsByTask.set(row.target_id, list);
  }
  for (const list of transitionsByTask.values()) list.sort((a, b) => a.at - b.at);

  // Running pointer + current status per task, advanced day by day so a
  // zero-transition sprint (or one with sparse transitions) is O(days + rows).
  const pointerByTask = new Map<string, number>();
  const statusByTask = new Map<string, string | undefined>();
  for (const id of committedTaskIds) {
    pointerByTask.set(id, 0);
    statusByTask.set(id, undefined);
  }

  const dates = enumerateDates(startDateStr, lastDateStr);
  const workingDays = enumerateDates(startDateStr, sprint.end_date).filter(isWeekday);
  const workingDayCount = Math.max(1, workingDays.length);

  const points: BurndownPoint[] = dates.map((dateStr) => {
    const cutoff = endOfDayMs(dateStr);
    for (const id of committedTaskIds) {
      const list = transitionsByTask.get(id) ?? [];
      let ptr = pointerByTask.get(id) ?? 0;
      while (ptr < list.length && list[ptr].at <= cutoff) {
        statusByTask.set(id, list[ptr].status);
        ptr += 1;
      }
      pointerByTask.set(id, ptr);
    }

    const completedPoints = committedTaskIds.reduce((sum, id) => {
      return statusByTask.get(id) === "completed" ? sum + safeNumber(committedSnapshot[id]) : sum;
    }, 0);

    const remaining = round1(Math.max(0, committedPoints - completedPoints));

    const idealWorkingDaysElapsed = workingDays.filter((d) => d <= dateStr).length;
    const ideal = round1(
      Math.max(0, committedPoints - (committedPoints / workingDayCount) * idealWorkingDaysElapsed),
    );

    return { date: dateStr, remaining, ideal };
  });

  return { points };
}
