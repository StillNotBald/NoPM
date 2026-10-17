import { cn } from "@/lib/cn";

/**
 * Risk heatmap — a PMBOK 5×5 probability × impact matrix.
 *
 * Pure server/static component (no client JS, no new deps): the grid is plain
 * CSS, each cell tinted by its exposure band using the existing semantic colour
 * tokens (--success / --warning / --info / --danger). Risks are bucketed into
 * cells by their probability_pct (→ 1-5 likelihood band) and impact_score, and
 * the per-cell count is rendered when non-zero.
 *
 * Scoring matches the register table exactly:
 *   risk_score = round(probability_pct / 20 × impact_score), clamped to 1-5.
 */

export type ExposureBand = "low" | "medium" | "high" | "critical";

/** probability_pct (0-100) → likelihood band 1-5 used for the matrix axis. */
export function probabilityBand(probabilityPct: number | null): number {
  if (probabilityPct == null) return 0;
  const band = Math.ceil(probabilityPct / 20);
  return Math.min(5, Math.max(1, band));
}

/** Computed exposure score: round(probability_pct/20 × impact_score), 1-5. */
export function riskScore(
  probabilityPct: number | null,
  impactScore: number | null,
): number | null {
  if (probabilityPct == null || impactScore == null) return null;
  const raw = Math.round((probabilityPct / 20) * impactScore);
  return Math.min(5, Math.max(1, raw));
}

/** 1-5 score → exposure band. */
export function exposureBand(score: number | null): ExposureBand | null {
  if (score == null) return null;
  if (score <= 1) return "low";
  if (score === 2) return "medium";
  if (score <= 4) return "high";
  return "critical";
}

const BAND_LABEL: Record<ExposureBand, string> = {
  low: "Low",
  medium: "Med",
  high: "High",
  critical: "Critical",
};

// Solid fill (the cell background) + a readable foreground for the count.
const BAND_FILL: Record<ExposureBand, string> = {
  low: "bg-success/15 text-success-ink",
  medium: "bg-warning/15 text-warning-ink",
  high: "bg-sev-high/15 text-sev-high-ink",
  critical: "bg-danger/25 text-danger-ink",
};

// The dot in the legend / band key.
const BAND_DOT: Record<ExposureBand, string> = {
  low: "bg-success",
  medium: "bg-warning",
  high: "bg-sev-high",
  critical: "bg-danger",
};

/** Band for a given (likelihood-band, impact) cell, used to colour the grid. */
function cellBand(probBand: number, impact: number): ExposureBand {
  // Reconstruct a representative probability_pct from the band (cell midpoint)
  // so the matrix colouring matches the scalar score the table shows.
  const probPctMid = probBand * 20 - 10;
  return exposureBand(riskScore(probPctMid, impact)) ?? "low";
}

type RiskCell = {
  probability_pct: number | null;
  impact_score: number | null;
};

export function RiskHeatmap({ risks }: { risks: RiskCell[] }) {
  // counts[impact 1..5][probBand 1..5]
  const counts: number[][] = Array.from({ length: 5 }, () =>
    Array.from({ length: 5 }, () => 0),
  );
  let scored = 0;
  for (const r of risks) {
    const pBand = probabilityBand(r.probability_pct);
    const impact = r.impact_score;
    if (pBand >= 1 && impact != null && impact >= 1 && impact <= 5) {
      counts[impact - 1][pBand - 1] += 1;
      scored += 1;
    }
  }

  const probAxis = ["1–20%", "21–40%", "41–60%", "61–80%", "81–100%"];
  const impactAxis = ["5", "4", "3", "2", "1"]; // top→bottom: high impact first

  return (
    // Sibling register table's proven pattern (src/app/(console)/risks/page.tsx):
    // overflow-x-auto wraps content that carries its own min-width, so it
    // scrolls horizontally on narrow viewports instead of squishing its cells
    // (or, worst case, forcing the page wide). `mx-auto` replaces the old
    // `flex justify-center` parent so a scrolled/overflowing row starts at
    // its left edge (scroll position 0) rather than the "centered flex item
    // overflow" clipping quirk. Desktop (room for the full 460px) is
    // pixel-identical: mx-auto centers exactly like justify-center did.
    <div className="overflow-x-auto">
      {/* Text alternative: per-cell counts for assistive tech (the visual grid is aria-hidden) */}
      <div className="sr-only"><table>
        <caption>Risk counts by impact (rows) and probability band (columns)</caption>
        <thead>
          <tr>
            <th scope="col">Impact</th>
            {probAxis.map((label) => (
              <th key={label} scope="col">
                Probability {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {impactAxis.map((impactLabel, rowIdx) => (
            <tr key={impactLabel}>
              <th scope="row">Impact {impactLabel}</th>
              {counts[4 - rowIdx].map((n, colIdx) => (
                <td key={colIdx}>{n}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table></div>
      <div aria-hidden="true" className="mx-auto flex items-stretch gap-3 max-w-[460px] w-full min-w-[420px]">
        {/* Y axis label */}
        <div className="flex items-center">
          <span className="rotate-180 text-2xs font-medium uppercase tracking-wide text-ink-muted [writing-mode:vertical-rl]">
            Impact (1–5)
          </span>
        </div>

        <div className="flex-1 min-w-0">
          {/* Grid: 5 impact rows (high→low) × 5 probability cols (low→high) */}
          <div className="grid grid-cols-[auto_repeat(5,minmax(0,1fr))] gap-1">
            {impactAxis.map((impactLabel, rowIdx) => {
              const impact = 5 - rowIdx; // 5,4,3,2,1
              return (
                <div key={impact} className="contents">
                  <div className="flex w-5 items-center justify-center text-[11px] font-medium text-ink-muted tabular-nums">
                    {impactLabel}
                  </div>
                  {Array.from({ length: 5 }, (_, colIdx) => {
                    const probBand = colIdx + 1; // 1..5
                    const count = counts[impact - 1][probBand - 1];
                    const band = cellBand(probBand, impact);
                    return (
                      <div
                        key={probBand}
                        title={`${BAND_LABEL[band]} exposure · ${count} risk${count === 1 ? "" : "s"}`}
                        className={cn(
                          "flex aspect-square items-center justify-center rounded text-xs font-semibold tabular-nums transition-colors min-h-[44px] max-h-[52px]",
                          BAND_FILL[band],
                          count === 0 && "opacity-40",
                        )}
                      >
                        {count > 0 ? count : ""}
                      </div>
                    );
                  })}
                </div>
              );
            })}

            {/* X axis: probability labels under each column */}
            <div />
            {probAxis.map((label) => (
              <div
                key={label}
                className="pt-1 text-center text-2xs font-medium text-ink-muted tabular-nums leading-tight"
              >
                {label}
              </div>
            ))}
          </div>

          <div className="mt-1 text-center text-2xs font-medium uppercase tracking-wide text-ink-muted">
            Probability
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-col justify-center gap-2 pl-2">
          {(Object.keys(BAND_LABEL) as ExposureBand[]).map((band) => (
            <span key={band} className="flex items-center gap-1.5 text-xs text-ink-secondary whitespace-nowrap">
              <span className={cn("h-2.5 w-2.5 shrink-0 rounded-sm", BAND_DOT[band])} aria-hidden="true" />
              {BAND_LABEL[band]}
            </span>
          ))}
          <span className="mt-1 text-2xs text-ink-muted whitespace-nowrap">
            {scored} scored
          </span>
        </div>
      </div>
    </div>
  );
}
