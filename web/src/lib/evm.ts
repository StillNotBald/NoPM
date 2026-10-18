import { DEFAULT_TIME_ZONE, todayInZone } from "@/lib/integrations/time-zone";

/**
 * Earned Value Management (EVM) — pure, read-only cost-performance math.
 *
 * Computes the PMBOK cost-performance number set from data NoPM already stores:
 *   BAC  = planned_amount (project_budget)
 *   AC   = actual_amount  (Σ expenses only — computed by the budget GET)
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
 * Forecast at completion (B3) — two methods, both always computed:
 *   eac_cpi       = BAC / CPI                           (the classic; null until money is spent)
 *   eac_bottom_up = AC + committed + estimate_to_complete (null while nobody has estimated the to-finish)
 *   eac           = whichever `forecast_method` selects ('cpi' by default). A method that
 *                   cannot be computed yields null: it never silently falls back to the other.
 *
 * Committed money and double counting. AC is expenses only. Nothing reduces a commitment
 * automatically when its invoice is entered as an expense, so the bottom-up forecast does
 * NOT use the raw `committed_amount`. It uses `committed_open` (commitments not yet
 * invoiced), which the owner lowers as invoices arrive; while `committed_open` is null it
 * falls back to `committed_amount`, and that fallback can double count an invoiced
 * commitment until someone lowers it. `estimate_to_complete` is the to-finish spend BEYOND
 * the open commitments. etc = eac − ac, so for the bottom-up method
 * etc = open commitments + estimate_to_complete.
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
  /** OPTIONAL — manual to-finish estimate beyond committed (project_budget.estimate_to_complete). */
  estimate_to_complete?: number | null;
  /** OPTIONAL — commitments not yet invoiced (project_budget.committed_open); null = use committed_amount. */
  committed_open?: number | null;
  /** OPTIONAL — which forecast is reported as `eac`. Default "cpi". */
  forecast_method?: ForecastMethod | null;
}

export type ForecastMethod = "cpi" | "bottom_up";
export const FORECAST_METHODS: readonly ForecastMethod[] = ["cpi", "bottom_up"];

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
  /** EAC — Estimate At Completion, per `forecast_method`. `null` when that method cannot be computed. */
  eac: number | null;
  /** EAC by cost performance (BAC / CPI). `null` when CPI is undefined. */
  eac_cpi: number | null;
  /** EAC bottom-up (AC + committed + estimate_to_complete). `null` when no to-finish estimate exists. */
  eac_bottom_up: number | null;
  /** The method `eac` follows. */
  forecast_method: ForecastMethod;
  /** The commitments used by the bottom-up forecast: committed_open when set, else committed. */
  committed_open: number;
  /** The manual to-finish estimate (beyond committed), passed through; null when not set. */
  estimate_to_complete: number | null;
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
  // Callers pass the workspace-zone date (workspaceToday); the fallback is the
  // default workspace zone, never UTC.
  const asOfResolved: string = input.as_of_date ?? todayInZone(DEFAULT_TIME_ZONE);

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

  const method: ForecastMethod = input.forecast_method === "bottom_up" ? "bottom_up" : "cpi";
  const rawEtc = input.estimate_to_complete;
  const estimateToComplete =
    rawEtc !== null && rawEtc !== undefined && Number.isFinite(Number(rawEtc)) && Number(rawEtc) >= 0
      ? Number(rawEtc)
      : null;

  // EAC (CPI) = BAC / CPI. Undefined when CPI is null (AC = 0).
  const eacCpi = cpi !== null && cpi > 0 ? bac / cpi : null;
  // EAC (bottom-up) = incurred + committed + to-finish. Undefined without a to-finish estimate.
  const rawOpen = input.committed_open;
  const openCommitted =
    rawOpen !== null && rawOpen !== undefined && Number.isFinite(Number(rawOpen)) && Number(rawOpen) >= 0
      ? Number(rawOpen)
      : committed;
  const eacBottomUp = estimateToComplete !== null ? ac + openCommitted + estimateToComplete : null;
  const eac = method === "bottom_up" ? eacBottomUp : eacCpi;
  const etc = eac !== null ? eac - ac : null;
  const vac = eac !== null ? bac - eac : null;

  return {
    bac, pv, ev, ac, committed, cv, sv, cpi, spi,
    eac, eac_cpi: eacCpi, eac_bottom_up: eacBottomUp, forecast_method: method,
    estimate_to_complete: estimateToComplete, committed_open: openCommitted, etc, vac,
  };
}
