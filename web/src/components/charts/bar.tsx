"use client";

/**
 * HorizontalBarChart — hand-rolled SVG horizontal bars (program / register counts).
 *
 * Props:
 *   items      Array of { label, value, color? }
 *   maxValue   Optional cap; defaults to max(values)
 *   barHeight  Individual bar height in px (default 16)
 *   gap        Gap between bars in px (default 10)
 *   showValues Show numeric label at bar end (default true)
 */

type BarItem = {
  label: string;
  value: number;
  color?: string;
};

type HorizontalBarProps = {
  items: BarItem[];
  maxValue?: number;
  barHeight?: number;
  gap?: number;
  showValues?: boolean;
};

export function HorizontalBarChart({
  items,
  maxValue,
  barHeight = 16,
  gap = 10,
  showValues = true,
}: HorizontalBarProps) {
  if (items.length === 0) {
    return (
      <p className="py-4 text-center text-xs text-ink-muted">No data</p>
    );
  }

  const max = maxValue ?? Math.max(...items.map((i) => i.value), 1);
  const labelWidth = 120; // px reserved for label text
  const valueWidth = showValues ? 36 : 0;
  const svgWidth = 400; // viewBox width; scales with CSS
  const trackWidth = svgWidth - labelWidth - valueWidth - 8;
  const totalHeight = items.length * (barHeight + gap) - gap;

  return (
    <svg
      viewBox={`0 0 ${svgWidth} ${totalHeight}`}
      width="100%"
      height={totalHeight}
      aria-label="Horizontal bar chart"
    >
      {items.map((item, i) => {
        const y = i * (barHeight + gap);
        const fillWidth = max > 0 ? (item.value / max) * trackWidth : 0;
        const fill = item.color ?? "var(--accent)";
        return (
          <g key={item.label}>
            {/* Label */}
            <text
              x={0}
              y={y + barHeight / 2}
              dominantBaseline="middle"
              fontSize={11}
              fill="var(--text-secondary)"
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
              fill="var(--bg-sunken)"
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
                fill="var(--text-muted)"
                fontFamily="ui-monospace, 'SF Mono', monospace"
              >
                {item.value}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
