"use client";

import { LineChart } from "@/components/charts/line";
import type { BurndownPoint } from "@/lib/insight/burndown";

/**
 * Sprint burndown chart (L-19) — thin client wrapper turning
 * `deriveBurndown`'s date/points series into the hand-rolled LineChart's
 * {x,y} shape. `x` is the day index (0-based) into `points`, not a raw
 * timestamp — the series is already daily and evenly spaced.
 */
export function BurndownChart({ points }: { points: BurndownPoint[] }) {
  if (points.length === 0) {
    return <p className="py-4 text-center text-xs text-ink-muted">No burndown yet — start the sprint.</p>;
  }

  const remaining = points.map((p, i) => ({ x: i, y: p.remaining }));
  const ideal = points.map((p, i) => ({ x: i, y: p.ideal }));

  return (
    <div className="space-y-2">
      <LineChart
        series={[
          { label: "Remaining", points: remaining, color: "var(--accent)" },
          { label: "Ideal", points: ideal, color: "var(--text-muted)", dashed: true },
        ]}
        height={160}
      />
      <div className="flex items-center justify-between text-[11px] text-ink-muted">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-3 rounded-full bg-accent" /> Remaining
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-3 rounded-full border border-dashed border-ink-muted" /> Ideal
          </span>
        </span>
        <span className="font-mono">
          {points[0].date} → {points[points.length - 1].date}
        </span>
      </div>
    </div>
  );
}
