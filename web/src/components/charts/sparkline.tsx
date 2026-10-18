"use client";

/**
 * Sparkline — hand-rolled SVG polyline sparkline for compact trend display.
 *
 * Props:
 *   data      Array of numbers (time series, left→right)
 *   width     SVG width in px (default 80)
 *   height    SVG height in px (default 24)
 *   color     Stroke colour (CSS colour string; defaults to var(--accent))
 *   fill      Whether to show area fill (default true)
 *   strokeWidth Line width (default 1.5)
 */

type SparklineProps = {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  strokeWidth?: number;
};

export function Sparkline({
  data,
  width = 80,
  height = 24,
  color = "var(--accent)",
  fill = true,
  strokeWidth = 1.5,
}: SparklineProps) {
  if (!data || data.length < 2) {
    // Render a flat line if insufficient data
    const mid = height / 2;
    return (
      <svg width={width} height={height} aria-hidden>
        <line
          x1={0}
          y1={mid}
          x2={width}
          y2={mid}
          stroke="var(--np-rule)"
          strokeWidth={strokeWidth}
        />
      </svg>
    );
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = strokeWidth + 1;

  // Map data points to SVG coordinates
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * (width - pad * 2) + pad;
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return [x, y] as [number, number];
  });

  const polylinePoints = points.map(([x, y]) => `${x},${y}`).join(" ");
  const areaPath = [
    `M ${points[0][0]},${height - pad}`,
    ...points.map(([x, y]) => `L ${x},${y}`),
    `L ${points[points.length - 1][0]},${height - pad}`,
    "Z",
  ].join(" ");

  return (
    <svg width={width} height={height} aria-hidden>
      {fill && (
        <path
          d={areaPath}
          fill={color}
          fillOpacity={0.12}
        />
      )}
      <polyline
        points={polylinePoints}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* End dot */}
      <circle
        cx={points[points.length - 1][0]}
        cy={points[points.length - 1][1]}
        r={2}
        fill={color}
      />
    </svg>
  );
}
