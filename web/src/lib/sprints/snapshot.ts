/**
 * Pure sprint commitment-snapshot math (L-17/L-18). Used by both
 * POST /api/sprints/{id}/start (committed_points/committed_snapshot) and
 * POST /api/sprints/{id}/close (completed_points/completed_snapshot) — the
 * two callers differ only in which tasks they pass in (all attached tasks
 * for start; attached tasks with status_type='completed' for close), never
 * in the aggregation itself.
 *
 * Snapshots are written ONCE at the matching transition and never
 * recomputed — a later edit to a task's story_points (or its removal from
 * the sprint) must not rewrite sprint history. This module has no DB access
 * and is called with whatever task rows the route already fetched at that
 * instant, so "never recomputed" is enforced by the ROUTE only calling this
 * at the start/close transition, not by anything in here.
 */
export type SnapshotSourceTask = {
  id: string;
  story_points: number | string | null;
};

export type SprintSnapshot = {
  points: number;
  snapshot: Record<string, number>;
};

/**
 * Sum story_points across the given tasks (missing/null points count as 0),
 * and record each task's individual contribution keyed by task id.
 * Rounded to 1 decimal place to match the DB column (numeric(8,1)).
 */
export function computeSprintSnapshot(tasks: SnapshotSourceTask[]): SprintSnapshot {
  const snapshot: Record<string, number> = {};
  let total = 0;

  for (const task of tasks) {
    const raw = task.story_points;
    const points = raw === null || raw === undefined ? 0 : Number(raw);
    const safePoints = Number.isFinite(points) ? points : 0;
    snapshot[task.id] = round1(safePoints);
    total += safePoints;
  }

  return { points: round1(total), snapshot };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
