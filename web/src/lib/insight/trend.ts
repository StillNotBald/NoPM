/**
 * Slip detection from trends, not a manual RAG (audit gap B6).
 *
 * Pure functions over the stored daily `project_snapshots` series. Nothing here
 * reads or writes the database, and NOTHING here sets a project's RAG: the output
 * is a SUGGESTION shown beside the declared RAG. The owner rule is that a
 * suggestion is never a decision.
 *
 * Rules for `rag_suggested`, over the last N snapshots (default 28). The
 * thresholds are constants below so the tests, the UI copy and the docs share one
 * source:
 *
 *   RED    slip_days > 10 on the latest snapshot, OR
 *          CPI < 0.90 on each of the last 3 snapshots, OR
 *          SPI < 0.90 on each of the last 3 snapshots.
 *   AMBER  (and not red) slip_days > 3 on the latest snapshot, OR
 *          latest CPI or SPI < 0.95, OR
 *          slip growing by more than 1 day a week while already slipping, OR
 *          CPI or SPI falling (lower than a week ago by more than 0.02, or than the
 *          oldest snapshot when the series is younger than a week) while the
 *          latest value is still below 1.00.
 *   GREEN  otherwise.
 *   none   no snapshots yet, or the latest snapshot is at 100% complete.
 *
 * `confidence` is "low" with fewer than 3 snapshots (a level can be read from one
 * snapshot, a direction cannot) and "ok" from 3 on.
 */

export type SuggestedRag = "green" | "amber" | "red";

export interface SnapshotPoint {
  taken_at: string; // YYYY-MM-DD
  spi: number | null;
  cpi: number | null;
  eac?: number | null;
  slip_days: number | null;
  completion_pct: number | null;
  open_risks_high?: number | null;
  rag_declared?: string | null;
}

export const TREND_WINDOW = 28;
export const MAX_TREND_WINDOW = 120;
export const TREND_THRESHOLDS = {
  /** red when the forecast end is more than this many days after the planned end */
  redSlipDays: 10,
  /** red when CPI or SPI stays below this for `redRun` snapshots in a row */
  redIndex: 0.9,
  redRun: 3,
  /** amber when the forecast end is later than this */
  amberSlipDays: 3,
  /** amber when the latest CPI or SPI is below this */
  amberIndex: 0.95,
  /** slip growth (days per week) that counts as "getting worse" */
  slipGrowthPerWeek: 1,
  /** a CPI/SPI change smaller than this is "flat" */
  indexEpsilon: 0.02,
  /** a step up smaller than this does not break a falling stretch */
  runTolerance: 0.005,
} as const;

export type Direction = "rising" | "falling" | "flat" | "unknown";

export interface IndexTrend {
  latest: number | null;
  direction: Direction;
  /** Days in the unbroken falling stretch ending at the latest snapshot (0 when not falling). */
  falling_days: number;
}

export interface TrendResult {
  snapshots: number;
  from: string | null;
  to: string | null;
  /** Change in slip_days per week across the window; null with fewer than 2 points or no slip data. */
  slip_per_week: number | null;
  latest_slip_days: number | null;
  spi: IndexTrend;
  cpi: IndexTrend;
  suggested_rag: SuggestedRag | null;
  confidence: "low" | "ok";
  /** The text the UI shows in brackets after the suggestion, e.g. "SPI 0.86 falling over 3 weeks". */
  reason: string;
}

const DAY_MS = 86_400_000;

function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY_MS);
}

/** Ascending by date, one point per day (last wins), at most the last `n`. */
export function normalizeSeries(points: readonly SnapshotPoint[], n: number = TREND_WINDOW): SnapshotPoint[] {
  const byDay = new Map<string, SnapshotPoint>();
  for (const p of points) byDay.set(p.taken_at.slice(0, 10), { ...p, taken_at: p.taken_at.slice(0, 10) });
  const sorted = [...byDay.values()].sort((a, b) => a.taken_at.localeCompare(b.taken_at));
  const size = Math.max(1, Math.min(MAX_TREND_WINDOW, Math.floor(n) || TREND_WINDOW));
  return sorted.slice(-size);
}

function indexTrend(series: SnapshotPoint[], key: "spi" | "cpi"): IndexTrend {
  const vals = series
    .map((p) => ({ day: dayNumber(p.taken_at), v: p[key] }))
    .filter((p): p is { day: number; v: number } => p.v !== null);
  if (vals.length === 0) return { latest: null, direction: "unknown", falling_days: 0 };
  const latest = vals[vals.length - 1].v;
  if (vals.length < 2) return { latest, direction: "unknown", falling_days: 0 };

  // Direction: the latest value against the one a week earlier (or the oldest, when the series is younger).
  const latestDay = vals[vals.length - 1].day;
  const weekAgo = [...vals].reverse().find((p) => p.day <= latestDay - 7) ?? vals[0];
  const delta = latest - weekAgo.v;
  const eps = TREND_THRESHOLDS.indexEpsilon;
  const direction: Direction = delta < -eps ? "falling" : delta > eps ? "rising" : "flat";

  // Falling stretch: walk back while each step down is not undone by a real step up.
  let i = vals.length - 1;
  while (i > 0 && vals[i].v <= vals[i - 1].v + TREND_THRESHOLDS.runTolerance) i--;
  const falling_days = direction === "falling" ? vals[vals.length - 1].day - vals[i].day : 0;
  return { latest, direction, falling_days };
}

function lastRunBelow(series: SnapshotPoint[], key: "spi" | "cpi", limit: number, run: number): boolean {
  const tail = series.slice(-run);
  return tail.length === run && tail.every((p) => p[key] !== null && (p[key] as number) < limit);
}

function describeIndex(name: string, t: IndexTrend): string {
  const base = `${name} ${(t.latest as number).toFixed(2)}`;
  if (t.direction === "falling") {
    const d = t.falling_days;
    const span = d >= 14 ? `${Math.round(d / 7)} weeks` : d >= 2 ? `${d} days` : "";
    return span ? `${base} falling over ${span}` : `${base} falling`;
  }
  if (t.direction === "rising") return `${base} rising`;
  return base;
}

export function computeTrend(points: readonly SnapshotPoint[], n: number = TREND_WINDOW): TrendResult {
  const series = normalizeSeries(points, n);
  const T = TREND_THRESHOLDS;
  if (series.length === 0) {
    return {
      snapshots: 0,
      from: null,
      to: null,
      slip_per_week: null,
      latest_slip_days: null,
      spi: { latest: null, direction: "unknown", falling_days: 0 },
      cpi: { latest: null, direction: "unknown", falling_days: 0 },
      suggested_rag: null,
      confidence: "low",
      reason: "No snapshots yet",
    };
  }
  const first = series[0];
  const last = series[series.length - 1];

  const slipPts = series.filter((p) => p.slip_days !== null);
  let slipPerWeek: number | null = null;
  if (slipPts.length >= 2) {
    const a = slipPts[0];
    const b = slipPts[slipPts.length - 1];
    const days = dayNumber(b.taken_at) - dayNumber(a.taken_at);
    if (days > 0) {
      slipPerWeek = Math.round((((b.slip_days as number) - (a.slip_days as number)) / days) * 7 * 10) / 10;
    }
  }
  const latestSlip = last.slip_days;

  const spi = indexTrend(series, "spi");
  const cpi = indexTrend(series, "cpi");

  let rag: SuggestedRag | null;
  if ((last.completion_pct ?? 0) >= 100) {
    rag = null;
  } else {
    const red =
      (latestSlip !== null && latestSlip > T.redSlipDays) ||
      lastRunBelow(series, "cpi", T.redIndex, T.redRun) ||
      lastRunBelow(series, "spi", T.redIndex, T.redRun);
    const worsening = (t: IndexTrend) => t.direction === "falling" && t.latest !== null && t.latest < 1;
    const amber =
      (latestSlip !== null && latestSlip > T.amberSlipDays) ||
      (spi.latest !== null && spi.latest < T.amberIndex) ||
      (cpi.latest !== null && cpi.latest < T.amberIndex) ||
      (slipPerWeek !== null && slipPerWeek > T.slipGrowthPerWeek && (latestSlip ?? 0) > 0) ||
      worsening(spi) ||
      worsening(cpi);
    rag = red ? "red" : amber ? "amber" : "green";
  }

  const parts: string[] = [];
  if (latestSlip !== null && latestSlip > 0) {
    const grow =
      slipPerWeek !== null && slipPerWeek > T.slipGrowthPerWeek ? `, growing ${slipPerWeek} days a week` : "";
    parts.push(`${latestSlip} days past plan${grow}`);
  }
  // The worse index first, so the headline is the number that drove the colour.
  const named = [
    { name: "SPI", t: spi },
    { name: "CPI", t: cpi },
  ]
    .filter((x) => x.t.latest !== null)
    .sort((a, b) => (a.t.latest as number) - (b.t.latest as number));
  for (const x of named) {
    if ((x.t.latest as number) < 1 || x.t.direction === "falling") parts.push(describeIndex(x.name, x.t));
  }
  const reason = parts.length > 0 ? parts.join("; ") : rag === null ? "Complete" : "On plan";

  return {
    snapshots: series.length,
    from: first.taken_at,
    to: last.taken_at,
    slip_per_week: slipPerWeek,
    latest_slip_days: latestSlip,
    spi,
    cpi,
    suggested_rag: rag,
    confidence: series.length >= 3 ? "ok" : "low",
    reason,
  };
}

/** "Suggested RAG: amber (SPI 0.86 falling over 3 weeks)", or null when there is nothing to suggest. */
export function suggestionLine(t: TrendResult): string | null {
  if (!t.suggested_rag) return null;
  return `Suggested RAG: ${t.suggested_rag} (${t.reason})`;
}
