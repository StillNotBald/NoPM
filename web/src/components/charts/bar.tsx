"use client";

/**
 * HorizontalBarChart — hand-rolled SVG horizontal bars (program / register
 * counts, and — via `displayValue` — the resources workload chart's
 * allocated-vs-capacity bars, L-13).
 *
 * Props:
 *   items      Array of { label, value, color?, displayValue? }
 *   maxValue   Optional cap; defaults to max(values)
 *   barHeight  Individual bar height in px (default 16)
 *   gap        Gap between bars in px (default 10)
 *   showValues Show a value label at bar end (default true)
 *   valueWidth Px reserved for the value label column (default 36; widen for longer displayValue strings)
 *
 * The viewBox is sized to the chart's real width (not a fixed 400 that CSS then
 * scales), so the 11px labels stay 11px: scaled down they were ~9px on a phone
 * and ~6px with the inspector open.
 */

import { useRef } from "react";
import { useElementWidth } from "@/components/timeline/use-timeline-viewport";

type BarItem = {
  label: string;
  value: number;
  color?: string;
  /**
   * Pre-formatted text shown in place of the raw `value` (e.g. "20 / 40h").
   * `value` still drives the bar's width — this only changes the label.
   */
  displayValue?: string;
};

type HorizontalBarProps = {
  items: BarItem[];
  maxValue?: number;
  barHeight?: number;
  gap?: number;
  showValues?: boolean;
  valueWidth?: number;
};

export function HorizontalBarChart({
  items,
  maxValue,
  barHeight = 16,
  gap = 10,
  showValues = true,
  valueWidth: valueWidthProp,
}: HorizontalBarProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const measured = useElementWidth(wrapRef);

  if (items.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-ink-muted">No data</p>
    );
  }

  const max = maxValue ?? Math.max(...items.map((i) => i.value), 1);
  const labelWidth = 120; // px reserved for label text
  const valueWidth = showValues ? (valueWidthProp ?? 36) : 0;
  const svgWidth = measured > 0 ? measured : 400; // 400 until measured (first paint)
  const trackWidth = Math.max(svgWidth - labelWidth - valueWidth - 8, 40);
  const totalHeight = items.length * (barHeight + gap) - gap;

  return (
    <div ref={wrapRef} className="w-full">
    <svg
      viewBox={`0 0 ${svgWidth} ${totalHeight}`}
      width="100%"
      height={totalHeight}
      aria-label="Horizontal bar chart"
    >
      {items.map((item, i) => {
        const y = i * (barHeight + gap);
        // Clamp to the track — over-max values (e.g. over-capacity) are
        // signalled via `color`, not by the fill spilling past the track.
        const fillWidth = max > 0 ? Math.min(1, item.value / max) * trackWidth : 0;
        const fill = item.color ?? "var(--accent)";
        return (
          <g key={item.label}>
            {/* Label */}
            <text
              x={0}
              y={y + barHeight / 2}
              dominantBaseline="middle"
              fontSize={11}
              fill="var(--np-fg-2)"
              fontFamily="inherit"
            >
              {item.label.length > 16 ? item.label.slice(0, 15) + "…" : item.label}
            </text>
            {/* Track */}
            <rect
              x={labelWidth}
              y={y}
              width={trackWidth}
              height={barHeight}
              rx={barHeight / 2}
              fill="var(--np-well)"
            />
            {/* Fill */}
            {fillWidth > 0 && (
              <rect
                x={labelWidth}
                y={y}
                width={fillWidth}
                height={barHeight}
                rx={barHeight / 2}
                fill={fill}
              />
            )}
            {/* Value label */}
            {showValues && (
              <text
                x={labelWidth + trackWidth + 6}
                y={y + barHeight / 2}
                dominantBaseline="middle"
                fontSize={11}
                fill="var(--np-fg-3)"
                fontFamily="ui-monospace, 'SF Mono', monospace"
              >
                {item.displayValue ?? item.value}
              </text>
            )}
          </g>
        );
      })}
    </svg>
    </div>
  );
}
