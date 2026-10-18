"use client";

/**
 * LineChart — hand-rolled SVG multi-series line chart (burndown, L-19).
 * Same house idiom as sparkline.tsx / bar.tsx: "use client", plain SVG,
 * CSS-var colors, no dependency.
 *
 * Props:
 *   series  Array of { label, points: {x,y}[], color?, dashed? }
 *   width   viewBox width in px (default 400; scales with CSS via width="100%")
 *   height  viewBox / rendered height in px (default 160)
 */

type ChartPoint = { x: number; y: number };

type ChartSeries = {
  label: string;
  points: ChartPoint[];
  color?: string;
  /** Dashed stroke — e.g. the "ideal" reference line vs the actual "remaining" line. */
  dashed?: boolean;
};

type LineChartProps = {
  series: ChartSeries[];
  width?: number;
  height?: number;
};

export function LineChart({ series, width = 400, height = 160 }: LineChartProps) {
  const allPoints = series.flatMap((s) => s.points);

  if (allPoints.length === 0) {
    return <p className="py-4 text-center text-xs text-ink-muted">No data</p>;
  }

  const xs = allPoints.map((p) => p.x);
  const ys = allPoints.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(...ys, 1);

  const pad = 8;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const xRange = maxX - minX || 1;
  const yRange = maxY - minY || 1;

  const scaleX = (x: number) => pad + ((x - minX) / xRange) * innerW;
  const scaleY = (y: number) => pad + innerH - ((y - minY) / yRange) * innerH;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      aria-label="Line chart"
    >
      {/* zero baseline */}
      <line
        x1={pad}
        y1={scaleY(0)}
        x2={width - pad}
        y2={scaleY(0)}
        stroke="var(--np-rule)"
        strokeWidth={1}
      />

      {series.map((s) => {
        if (s.points.length === 0) return null;
        const color = s.color ?? "var(--accent)";
        const sorted = [...s.points].sort((a, b) => a.x - b.x);

        if (sorted.length === 1) {
          const [p] = sorted;
          return (
            <circle
              key={s.label}
              cx={scaleX(p.x)}
              cy={scaleY(p.y)}
              r={2.5}
              fill={color}
            />
          );
        }

        const d = sorted
          .map((p, i) => `${i === 0 ? "M" : "L"} ${scaleX(p.x)},${scaleY(p.y)}`)
          .join(" ");

        return (
          <path
            key={s.label}
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeDasharray={s.dashed ? "4 3" : undefined}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      })}
    </svg>
  );
}
