/**
 * Earned Value Management (EVM) — pure, read-only cost-performance math.
 *
 * Computes the PMBOK cost-performance number set from data NoPM already stores:
 *   BAC  = planned_amount (project_budget)
 *   AC   = actual_amount  (Σ time_entries.cost + Σ expenses — computed by the budget GET)
 *   EV   = BAC × completion_pct / 100  (project completion)
 *   PV   = BAC × planned-schedule %    (approximated with completion_pct until a
 *                                       schedule baseline / planned-% basis lands)
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
 * Compute the full EVM number set. Pure function — same input, same output.
 *
 * PV approximation: with no schedule baseline stored, planned-schedule % is
 * approximated by completion_pct, so PV == EV and SPI == 1 (schedule-neutral)
 * until a real planned-% basis exists. This keeps the panel honest rather than
 * inventing a schedule signal NoPM cannot yet derive.
 */
export function computeEvm(input: EvmInput): EvmResult {
  const bac = Number.isFinite(input.planned_amount) ? input.planned_amount : 0;
  const ac = Number.isFinite(input.actual_amount) ? input.actual_amount : 0;
  const committed = Number.isFinite(input.committed_amount)
    ? input.committed_amount
    : 0;

  const completion = clampPct(input.completion_pct);
  // No schedule baseline yet → approximate planned-schedule % with completion %.
  const plannedSchedulePct = completion;

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
