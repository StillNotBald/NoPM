/**
 * Arc geometry for the SVG donut, kept free of React so it can be unit-tested.
 *
 * Each slice is one full-circle `<circle>` stroked with a dash pattern. For a
 * slice that starts `startLength` along the circumference and is `dash` long:
 *
 *   stroke-dasharray  = `${dash} ${circumference - dash}`  (one dash, then the rest blank)
 *   stroke-dashoffset = -startLength                        (negative = pattern moves FORWARD
 *                                                            along the path, so the dash begins
 *                                                            `startLength` in)
 *
 * The previous maths used `${dash} ${circumference}` with a positive offset of
 * `circumference * (1 - cumulativePct)`. With a dash period of `dash + C` the
 * slice was painted one slice-length too late, so the first slice vanished,
 * the rest were shifted and a single-slice donut was a blank ring.
 *
 * The caller rotates the SVG -90deg so slice 0 starts at 12 o'clock and the
 * slices run clockwise in the order given.
 */

export interface DonutArc<T> {
  seg: T;
  /** Arc length (px) from 12 o'clock to where this slice starts. */
  startLength: number;
  /** Painted arc length (px); already shortened by the inter-slice gap. */
  dash: number;
  dasharray: string;
  dashoffset: number;
}

/** Visual gap (px) between neighbouring slices; only used with 2+ slices. */
export const DONUT_GAP = 1.5;

export function computeDonutArcs<T extends { value: number }>(
  segments: readonly T[],
  circumference: number,
  gap: number = DONUT_GAP,
): DonutArc<T>[] {
  const positive = segments.filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = positive.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0 || circumference <= 0) return [];

  // A lone slice is a full ring: no gap to leave.
  const gapPx = positive.length > 1 ? gap : 0;

  let startLength = 0;
  return positive.map((seg) => {
    const length = (seg.value / total) * circumference;
    const dash = Math.max(length - gapPx, 0);
    const arc: DonutArc<T> = {
      seg,
      startLength,
      dash,
      dasharray: `${dash} ${Math.max(circumference - dash, 0)}`,
      // `-0` would serialise to "0" anyway; normalise so equality checks are exact.
      dashoffset: startLength === 0 ? 0 : -startLength,
    };
    startLength += length;
    return arc;
  });
}
