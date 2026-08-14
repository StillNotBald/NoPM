/**
 * Estimate variance (L-33) — pure hours/% math for the project task table's
 * variance column and its project-level rollup line.
 *
 * `actualHours` is expected to already be a per-task sum of
 * `time_entries.hours` (Σ per `task_id`), fetched by the caller in ONE
 * batched query — see `src/app/(console)/projects/[id]/page.tsx`. No I/O
 * here, so this is trivially unit-testable.
 */

/** Overrun flag threshold — a task/project more than this % over its estimate is flagged. */
export const OVERRUN_THRESHOLD_PCT = 20;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface TaskVarianceInput {
  id: string;
  /** Task's estimate_hours — null/undefined means "no estimate", excluded from % rollups. */
  estimateHours: number | null | undefined;
  /** Σ time_entries.hours for this task (0 when none logged). */
  actualHours: number;
}

export interface TaskVariance {
  /** actual - estimate, one-decimal rounded. null when there is no estimate. */
  varianceHours: number | null;
  /** variance / estimate * 100, one-decimal rounded. null with no estimate, or a zero-hour estimate. */
  variancePct: number | null;
  /** true when variancePct exceeds OVERRUN_THRESHOLD_PCT. Always false with no estimate. */
  isOverrun: boolean;
}

/** Per-task variance — the value that lands in the task table's "Variance" column. */
export function taskVariance(input: TaskVarianceInput): TaskVariance {
  const estimateHours = input.estimateHours;
  if (estimateHours == null) {
    return { varianceHours: null, variancePct: null, isOverrun: false };
  }

  const actualHours = Number.isFinite(input.actualHours) ? input.actualHours : 0;
  const varianceHours = round1(actualHours - estimateHours);
  // Divide-by-zero guard: a declared-but-zero estimate has no meaningful %.
  const variancePct = estimateHours !== 0 ? round1((varianceHours / estimateHours) * 100) : null;
  const isOverrun = variancePct !== null && variancePct > OVERRUN_THRESHOLD_PCT;

  return { varianceHours, variancePct, isOverrun };
}

export interface ProjectVarianceRollup {
  /** Sum of estimate_hours across tasks that HAVE an estimate. */
  totalEstimateHours: number;
  /** Sum of actual hours across those same (estimate-having) tasks — the basis for variancePct. */
  totalActualHours: number;
  /** totalActualHours - totalEstimateHours, one-decimal rounded. */
  varianceHours: number;
  /** varianceHours / totalEstimateHours * 100. null when no included task has a non-zero estimate. */
  variancePct: number | null;
  /** true when variancePct exceeds OVERRUN_THRESHOLD_PCT. */
  isOverrun: boolean;
  /** Count of tasks WITH an estimate — the ones counted in variancePct. */
  includedCount: number;
  /** Count of tasks with NO estimate — excluded from variancePct (state this to the user). */
  excludedCount: number;
  /** Actual hours logged against no-estimate tasks — informational, not folded into variancePct. */
  excludedActualHours: number;
}

/** Project-level rollup line — one query's worth of tasks in, one summary out. */
export function projectVarianceRollup(tasks: readonly TaskVarianceInput[]): ProjectVarianceRollup {
  let totalEstimateHours = 0;
  let totalActualHours = 0;
  let excludedActualHours = 0;
  let includedCount = 0;
  let excludedCount = 0;

  for (const t of tasks) {
    const actualHours = Number.isFinite(t.actualHours) ? t.actualHours : 0;
    if (t.estimateHours == null) {
      excludedCount++;
      excludedActualHours += actualHours;
      continue;
    }
    includedCount++;
    totalEstimateHours += t.estimateHours;
    totalActualHours += actualHours;
  }

  const varianceHours = round1(totalActualHours - totalEstimateHours);
  const variancePct = totalEstimateHours !== 0 ? round1((varianceHours / totalEstimateHours) * 100) : null;
  const isOverrun = variancePct !== null && variancePct > OVERRUN_THRESHOLD_PCT;

  return {
    totalEstimateHours: round1(totalEstimateHours),
    totalActualHours: round1(totalActualHours),
    varianceHours,
    variancePct,
    isOverrun,
    includedCount,
    excludedCount,
    excludedActualHours: round1(excludedActualHours),
  };
}
