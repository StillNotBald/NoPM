"use client";

/**
 * DonutChart — hand-rolled SVG donut (RAG split).
 *
 * Props:
 *   segments  Array of { label, value, color } — color is a CSS colour string
 *   size      SVG diameter in px (default 120)
 *   thickness Ring thickness in px (default 18)
 *   children  Optional centre slot (label / number)
 */

type Segment = {
  label: string;
  value: number;
  color: string;
};

type DonutProps = {
  segments: Segment[];
  size?: number;
  thickness?: number;
  children?: React.ReactNode;
};

export function DonutChart({ segments, size = 120, thickness = 18, children }: DonutProps) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;

  // Build arc paths from segment values
  const positiveSegs = segments.filter((seg) => seg.value > 0);
  const gap = total > 0 && positiveSegs.length > 1 ? 1.5 : 0;
  const arcs = positiveSegs.reduce<{ seg: Segment; offset: number; dash: number }[]>(
    (acc, seg) => {
      const pct = total > 0 ? seg.value / total : 0;
      const cumulativePct = acc.reduce((s, a) => s + (total > 0 ? a.seg.value / total : 0), 0);
      const offset = circumference * (1 - cumulativePct);
      const dash = circumference * pct;
      acc.push({ seg, offset, dash: dash - gap });
      return acc;
    },
    [],
  );

  if (total === 0) {
    // Empty state: grey ring
    return (
      <div style={{ width: size, height: size }} className="relative flex items-center justify-center">
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }} aria-hidden>
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="var(--border-subtle)"
            strokeWidth={thickness}
          />
        </svg>
        {children && (
          <div className="absolute inset-0 flex items-center justify-center">
            {children}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      style={{ width: size, height: size }}
      className="relative flex items-center justify-center"
    >
      <svg
        width={size}
        height={size}
        style={{ transform: "rotate(-90deg)" }}
        aria-hidden
      >
        {/* Track */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="var(--border-subtle)"
          strokeWidth={thickness}
        />
        {/* Segments */}
        {arcs.map(({ seg, offset, dash }) => (
          <circle
            key={seg.label}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={seg.color}
            strokeWidth={thickness}
            strokeDasharray={`${dash} ${circumference}`}
            strokeDashoffset={offset}
            strokeLinecap="butt"
          />
        ))}
      </svg>
      {children && (
        <div className="absolute inset-0 flex items-center justify-center">
          {children}
        </div>
      )}
    </div>
  );
}

/** Compact legend row for the donut */
export function DonutLegend({ segments }: { segments: Segment[] }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  return (
    <ul className="mt-1 space-y-1.5">
      {segments.map((seg) => {
        const pct = total > 0 ? Math.round((seg.value / total) * 100) : 0;
        return (
          <li key={seg.label} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-xs text-ink-secondary">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: seg.color }}
              />
              {seg.label}
            </span>
            <span className="font-mono text-xs tabular-nums text-ink">
              {seg.value}
              <span className="ml-1 text-ink-muted">({pct}%)</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
