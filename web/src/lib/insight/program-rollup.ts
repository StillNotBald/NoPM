/**
 * Program rollup (L-03) — pure aggregation math for the program rollup card:
 * completion %, budget variance, actual vs planned cost, allocated vs
 * capacity effort — derived from a program's CHILD PROJECTS, batched by the
 * caller (see `src/app/(console)/portfolio/page.tsx`) in the same style as
 * `src/app/(console)/budget/page.tsx`'s portfolio EVM roll-up and
 * `src/lib/resource/utilisation.ts`'s workspace summary. No I/O here, so
 * this is trivially unit-testable.
 *
 * Also carries `computeChildRag` (L-02) — the COMPUTED health used to flag
 * divergence against a program's DECLARED `rag_status` (settable via PATCH,
 * never overwritten by this computation — see programs._schema.ts).
 */

import type { RagStatus } from "@/lib/status";

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function safeNum(n: number): number {
  return Number.isFinite(n) ? n : 0;
}

/** Clamp a percentage into the valid 0–100 range (defensive against bad data). */
function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

export interface ProgramRollupChildInput {
  /** projects.id — for traceability only, not used in the math. */
  projectId: string;
  /** projects.completion_pct (0–100). */
  completionPct: number;
  /** project_budget.planned_amount — 0 when the project has no budget row (BAC). */
  plannedAmount: number;
  /** project_budget.committed_amount — 0 when the project has no budget row. */
  committedAmount: number;
  /** Σ expenses.amount for this project (mirrors the /budget GET). */
  actualAmount: number;
  /** project_budget.currency (or the project's own currency when no budget row exists). */
  currency: string;
  /**
   * Σ allocated hours/week attributable to this project — allocations.hours
   * when set, else allocation_pct/100 * the member's capacity_hours_per_week
   * (mirrors `memberUtilisation`'s hour-derivation in lib/resource/utilisation.ts).
   */
  allocatedHours: number;
  /**
   * Σ capacity_hours_per_week of the DISTINCT resource_members allocated to
   * this project — the denominator for "allocated vs capacity".
   */
  capacityHours: number;
}

export interface ProgramRollup {
  /** Number of child projects included in this rollup. */
  projectCount: number;
  /**
   * BAC-weighted completion % across child projects (Σ EV / Σ BAC × 100,
   * same convention as the budget page's "portfolio roll-up"). Falls back to
   * a simple average when every child has a zero/absent budget. `null` when
   * there are zero child projects (empty-state — never NaN/0).
   */
  completionPct: number | null;
  /** Σ plannedAmount across children (BAC). */
  plannedAmount: number;
  /** Σ committedAmount across children. */
  committedAmount: number;
  /** Σ actualAmount across children (AC). */
  actualAmount: number;
  /** plannedAmount − actualAmount. Positive = under budget. */
  budgetVariance: number;
  /** actualAmount / plannedAmount × 100. `null` when plannedAmount is 0. */
  burnPct: number | null;
  /** Σ allocatedHours across children. */
  allocatedHours: number;
  /** Σ capacityHours across children. */
  capacityHours: number;
  /** allocatedHours / capacityHours × 100. `null` when capacityHours is 0. */
  allocatedVsCapacityPct: number | null;
  /** The common currency across every child with a non-zero budget, else `null` (mixed — caller shows "—" for money, matching the budget page's `allSameCurrency` convention). */
  currency: string | null;
}

const EMPTY_ROLLUP: ProgramRollup = {
  projectCount: 0,
  completionPct: null,
  plannedAmount: 0,
  committedAmount: 0,
  actualAmount: 0,
  budgetVariance: 0,
  burnPct: null,
  allocatedHours: 0,
  capacityHours: 0,
  allocatedVsCapacityPct: null,
  currency: null,
};

/**
 * Aggregate a program's child projects into one rollup. Zero children →
 * an explicit empty-state shape (all nulls where "no data" is the honest
 * answer), never NaN/0 masquerading as a real number.
 */
export function computeProgramRollup(
  children: readonly ProgramRollupChildInput[],
): ProgramRollup {
  const projectCount = children.length;
  if (projectCount === 0) return { ...EMPTY_ROLLUP };

  let plannedAmount = 0;
  let committedAmount = 0;
  let actualAmount = 0;
  let allocatedHours = 0;
  let capacityHours = 0;
  let evSum = 0; // Σ (planned_i × completion_i / 100)
  let simpleCompletionSum = 0;

  const currencies = new Set<string>();

  for (const c of children) {
    const planned = safeNum(c.plannedAmount);
    const committed = safeNum(c.committedAmount);
    const actual = safeNum(c.actualAmount);
    const completion = clampPct(c.completionPct);

    plannedAmount += planned;
    committedAmount += committed;
    actualAmount += actual;
    allocatedHours += safeNum(c.allocatedHours);
    capacityHours += safeNum(c.capacityHours);
    evSum += (planned * completion) / 100;
    simpleCompletionSum += completion;

    // Only consider a project's currency when it actually carries budget —
    // an unbudgeted project's default currency shouldn't force a "mixed"
    // read on an otherwise single-currency program.
    if (planned > 0 || committed > 0) currencies.add(c.currency);
  }

  const completionPct =
    plannedAmount > 0
      ? round1((evSum / plannedAmount) * 100)
      : round1(simpleCompletionSum / projectCount);

  const budgetVariance = round1(plannedAmount - actualAmount);
  const burnPct = plannedAmount > 0 ? round1((actualAmount / plannedAmount) * 100) : null;
  const allocatedVsCapacityPct =
    capacityHours > 0 ? round1((allocatedHours / capacityHours) * 100) : null;

  // "Same currency" when every budgeted child agrees (0 or 1 distinct value).
  // No budgeted child at all → currency is undefined, not "mixed"; report
  // null (caller shows "—") rather than guessing.
  const currency = currencies.size === 1 ? [...currencies][0] : null;

  return {
    projectCount,
    completionPct,
    plannedAmount: round1(plannedAmount),
    committedAmount: round1(committedAmount),
    actualAmount: round1(actualAmount),
    budgetVariance,
    burnPct,
    allocatedHours: round1(allocatedHours),
    capacityHours: round1(capacityHours),
    allocatedVsCapacityPct,
    currency,
  };
}

// ---------------------------------------------------------------------------
// L-02 — computed child RAG vs the program's declared RAG.
// ---------------------------------------------------------------------------

/** Severity order, worst first — the first status found among children wins. */
const SEVERITY_ORDER: readonly RagStatus[] = ["red", "amber", "not_started", "green"];

/**
 * Roll a set of child projects' `rag_status` values up into one computed
 * health value: worst-status-wins (red > amber > not_started > green),
 * EXCEPT that a program whose every child is `complete` computes as
 * `complete` rather than falling through to `green`. `null` with zero
 * children (nothing to compute from).
 */
export function computeChildRag(childStatuses: readonly RagStatus[]): RagStatus | null {
  if (childStatuses.length === 0) return null;
  if (childStatuses.every((s) => s === "complete")) return "complete";
  for (const level of SEVERITY_ORDER) {
    if (childStatuses.includes(level)) return level;
  }
  // Every status was "complete" and/or "green" but not ALL complete — the
  // non-complete remainder is "green" (no red/amber/not_started present).
  return "green";
}
