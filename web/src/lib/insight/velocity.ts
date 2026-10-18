/**
 * Sprint velocity (L-20) — pure aggregation over a project's CLOSED sprints.
 *
 * Callers must pass `closedSprints` ordered oldest-closed-first
 * (`closed_at` ascending) — the rolling average is computed over the LAST
 * (most recent) up-to-3 entries of the array as given, this module does not
 * re-sort. Fewer than 2 closed sprints is "not enough history" (a single
 * data point can't show a trend) and the UI shows a caption instead of a
 * chart.
 */

export interface ClosedSprintForVelocity {
  id: string;
  name: string;
  committed_points: number | string | null | undefined;
  completed_points: number | string | null | undefined;
}

export interface VelocityBar {
  id: string;
  name: string;
  committed: number;
  completed: number;
}

export type VelocityResult =
  | { insufficient: true }
  | {
      insufficient: false;
      bars: VelocityBar[];
      /** Average `completed` over the last up-to-3 bars, rounded to 1 decimal. */
      rollingAverage: number;
    };

function safeNumber(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function computeVelocity(closedSprints: readonly ClosedSprintForVelocity[]): VelocityResult {
  if (closedSprints.length < 2) return { insufficient: true };

  const bars: VelocityBar[] = closedSprints.map((s) => ({
    id: s.id,
    name: s.name,
    committed: safeNumber(s.committed_points),
    completed: safeNumber(s.completed_points),
  }));

  const lastThree = bars.slice(-3);
  const rollingAverage = round1(
    lastThree.reduce((sum, b) => sum + b.completed, 0) / lastThree.length,
  );

  return { insufficient: false, bars, rollingAverage };
}
