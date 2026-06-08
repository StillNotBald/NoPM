/**
 * Earned Value Management (EVM) — pure, read-only cost-performance math.
 *
 * Computes the PMBOK cost-performance number set from data NoPM already stores:
 *   BAC  = planned_amount (project_budget)
 *   AC   = actual_amount  (Σ time_entries.cost + Σ expenses — computed by the budget GET)
 *   EV   = BAC × completion_pct / 100  (project completion)
 *   PV   = BAC × planned-schedule %
 *
 * PV / SPI — two modes:
 *   Schedule-aware (preferred): when baseline_start_date, baseline_target_date, and
 *   as_of_date are all supplied, PV is computed from elapsed-vs-planned duration:
 *     plannedSchedulePct = (asOf − baselineStart) / (baselineTarget − baselineStart) × 100
 *   This makes SPI meaningful — a project behind its baseline schedule will show SPI < 1.
 *
 *   Fallback (backward-compatible): when any baseline date is absent, plannedSchedulePct
 *   is approximated by completion_pct (PV == EV, SPI == 1.00, schedule-neutral).
 *
 * No I/O, no side effects, no audit — derived numbers only (constitution-safe).
 * Every ratio guards divide-by-zero and returns `null` when undefined.
 */

export interface EvmInput {
  /** BAC — Budget At Completion (project_budget.planned_amount). */
  planned_amount: number;
  /** Project completion, 0–100 (projects.completion_pct). */
  completion_pct: number;
  /** Committed amount (project_budget.committed_amount) — passed through for context. */
  committed_amount: number;
  /** AC — Actual Cost (Σ time.cost + Σ expenses), as computed by the budget GET. */
  actual_amount: number;
  /**
   * OPTIONAL — PMBOK baseline start date (ISO 8601 date string, e.g. "2025-01-15").
   * Required together with baseline_target_date and as_of_date for schedule-aware SPI.
   */
  baseline_start_date?: string | null;
  /**
   * OPTIONAL — PMBOK baseline finish date (ISO 8601 date string).
   * Required together with baseline_start_date and as_of_date for schedule-aware SPI.
   */
  baseline_target_date?: string | null;
  /**
   * OPTIONAL — The reporting date used as "today" for schedule-based PV (ISO 8601).
   * Defaults to the current date when omitted. Accepted as a parameter so callers can
   * pass a deterministic date in tests and the function remains pure.
   */
  as_of_date?: string | null;
}

export interface EvmResult {
  /** BAC — Budget At Completion. */
  bac: number;
  /** PV — Planned Value (budgeted cost of work scheduled). */
  pv: number;
  /** EV — Earned Value (budgeted cost of work performed). */
  ev: number;
  /** AC — Actual Cost (budgeted cost of work actually incurred). */
  ac: number;
  /** Committed amount, passed through. */
  committed: number;
  /** CV — Cost Variance (EV − AC). */
  cv: number;
  /** SV — Schedule Variance (EV − PV). */
  sv: number;
  /** CPI — Cost Performance Index (EV / AC). `null` when AC = 0. */
  cpi: number | null;
  /** SPI — Schedule Performance Index (EV / PV). `null` when PV = 0. */
  spi: number | null;
  /** EAC — Estimate At Completion (BAC / CPI). `null` when CPI is undefined. */
  eac: number | null;
  /** ETC — Estimate To Complete (EAC − AC). `null` when EAC is undefined. */
  etc: number | null;
  /** VAC — Variance At Completion (BAC − EAC). `null` when EAC is undefined. */
  vac: number | null;
}

/** Clamp a percentage into the valid 0–100 range (defensive against bad data). */
function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

/**
 * Parse an ISO 8601 date string ("YYYY-MM-DD" or full ISO timestamp) into a UTC
 * midnight timestamp (ms). Returns `null` for missing / unparseable values.
 */
function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Derive a schedule-based planned-% from baseline dates and a reporting date.
 *
 * plannedSchedulePct = clamp((asOf − baselineStart) / (baselineTarget − baselineStart) × 100, 0, 100)
 *
 * Returns `null` when any date is missing or the baseline duration is zero (guard
 * against same-day start = target edge case).
 */
function schedulePlannedPct(
  baselineStart: string | null | undefined,
  baselineTarget: string | null | undefined,
  asOf: string | null | undefined,
): number | null {
  const start = parseDate(baselineStart);
  const target = parseDate(baselineTarget);
  const ref = parseDate(asOf);
  if (start === null || target === null || ref === null) return null;
  const duration = target - start;
  if (duration <= 0) return null; // degenerate baseline
  return clampPct(((ref - start) / duration) * 100);
}

/**
 * Compute the full EVM number set. Pure function — same input, same output.
 *
 * SPI mode selection:
 *   • Schedule-aware: baseline_start_date + baseline_target_date + as_of_date supplied
 *     → PV derived from elapsed-vs-planned duration; SPI reflects real schedule position.
 *   • Fallback (backward-compatible): any date absent → plannedSchedulePct = completion_pct,
 *     PV == EV, SPI == 1.00 (schedule-neutral, honest about missing data).
 */
export function computeEvm(input: EvmInput): EvmResult {
  const bac = Number.isFinite(input.planned_amount) ? input.planned_amount : 0;
  const ac = Number.isFinite(input.actual_amount) ? input.actual_amount : 0;
  const committed = Number.isFinite(input.committed_amount)
    ? input.committed_amount
    : 0;

  const completion = clampPct(input.completion_pct);

  // Resolve as_of_date: use provided value, or today's date (ISO string).
  const asOfResolved: string =
    input.as_of_date ??
    new Date().toISOString().slice(0, 10);

  // Attempt schedule-aware PV; fall back to completion-% approximation.
  const schedPct = schedulePlannedPct(
    input.baseline_start_date,
    input.baseline_target_date,
    asOfResolved,
  );
  // If schedule dates were supplied but produced null (degenerate), stay with fallback.
  const plannedSchedulePct = schedPct !== null ? schedPct : completion;

  const ev = (bac * completion) / 100;
  const pv = (bac * plannedSchedulePct) / 100;

  const cv = ev - ac;
  const sv = ev - pv;

  // Guard divide-by-zero: undefined index → null (not Infinity / NaN).
  const cpi = ac > 0 ? ev / ac : null;
  const spi = pv > 0 ? ev / pv : null;

  // EAC = BAC / CPI. Undefined when CPI is null (AC = 0).
  const eac = cpi !== null && cpi > 0 ? bac / cpi : null;
  const etc = eac !== null ? eac - ac : null;
  const vac = eac !== null ? bac - eac : null;

  return { bac, pv, ev, ac, committed, cv, sv, cpi, spi, eac, etc, vac };
}
