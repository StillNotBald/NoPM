"use client";

import { HorizontalBarChart } from "@/components/charts/bar";
import type { VelocityResult } from "@/lib/insight/velocity";

/**
 * Sprint velocity chart (L-20) — reuses HorizontalBarChart per T2 spec:
 * bar width is driven by `completed` (delivered work), `displayValue`
 * shows "committed / completed" so the commitment is still legible per bar.
 */
export function VelocityChart({ velocity }: { velocity: VelocityResult }) {
  if (velocity.insufficient) {
    return (
      <p className="py-4 text-center text-xs text-ink-muted">
        Needs at least 2 closed sprints.
      </p>
    );
  }

  const items = velocity.bars.map((b) => ({
    label: b.name,
    value: b.completed,
    displayValue: `${b.committed} / ${b.completed}`,
  }));
  const maxValue = Math.max(...velocity.bars.map((b) => Math.max(b.committed, b.completed)), 1);

  return (
    <div className="space-y-2">
      <HorizontalBarChart items={items} maxValue={maxValue} valueWidth={64} />
      <p className="text-[11px] text-ink-muted">
        3-sprint rolling average: <span className="font-mono text-ink">{velocity.rollingAverage} pts</span>
      </p>
    </div>
  );
}
