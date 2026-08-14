/**
 * Capacity / utilisation maths for the resource view.
 *
 * All arithmetic is pure so it can be tested without a DB connection.
 */

export interface UtilisationStats {
  /** Total allocation percentage (sum of allocation_pct rows). */
  allocatedPct: number;
  /** Hours per week committed via allocations — null when capacity_hours_per_week is null. */
  allocatedHours: number | null;
  /** Remaining free hours per week — null when capacity_hours_per_week is null. */
  freeHours: number | null;
  /** True when total allocation exceeds 100 %. */
  isOver: boolean;
}

/**
 * Derive per-member utilisation stats from raw allocation percentage and
 * the member's declared weekly capacity.
 */
export function memberUtilisation(
  totalAllocationPct: number,
  capacityHoursPerWeek: number | null,
): UtilisationStats {
  const isOver = totalAllocationPct > 100;

  if (capacityHoursPerWeek == null) {
    return {
      allocatedPct: totalAllocationPct,
      allocatedHours: null,
      freeHours: null,
      isOver,
    };
  }

  const allocatedHours = (totalAllocationPct / 100) * capacityHoursPerWeek;
  const freeHours = capacityHoursPerWeek - allocatedHours;

  return {
    allocatedPct: totalAllocationPct,
    allocatedHours: Math.round(allocatedHours * 10) / 10,
    freeHours: Math.round(freeHours * 10) / 10,
    isOver,
  };
}

export interface WorkspaceSummary {
  /** Sum of capacity_hours_per_week across members that have it set. */
  totalCapacityHours: number;
  /** Sum of allocated hours across members that have capacity set. */
  totalAllocatedHours: number;
  /** Overall utilisation: totalAllocatedHours / totalCapacityHours * 100. null when totalCapacityHours === 0. */
  overallUtilisationPct: number | null;
  /** Number of members with totalAllocationPct > 100. */
  membersOverCapacity: number;
}

export interface WorkspaceMemberInput {
  capacityHoursPerWeek: number | null;
  totalAllocationPct: number;
}

/** Aggregate workspace-level capacity stats from per-member inputs. */
export function workspaceSummary(members: WorkspaceMemberInput[]): WorkspaceSummary {
  let totalCapacityHours = 0;
  let totalAllocatedHours = 0;
  let membersOverCapacity = 0;

  for (const m of members) {
    if (m.capacityHoursPerWeek != null) {
      totalCapacityHours += m.capacityHoursPerWeek;
      totalAllocatedHours +=
        Math.round(((m.totalAllocationPct / 100) * m.capacityHoursPerWeek) * 10) / 10;
    }
    if (m.totalAllocationPct > 100) membersOverCapacity++;
  }

  const overallUtilisationPct =
    totalCapacityHours > 0
      ? Math.round((totalAllocatedHours / totalCapacityHours) * 1000) / 10
      : null;

  return {
    totalCapacityHours: Math.round(totalCapacityHours * 10) / 10,
    totalAllocatedHours: Math.round(totalAllocatedHours * 10) / 10,
    overallUtilisationPct,
    membersOverCapacity,
  };
}

/** Format a number to at most one decimal place, dropping ".0" for whole numbers. */
export function fmtHours(h: number): string {
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

// ---------------------------------------------------------------------------
// Period-aware capacity (L-13 workload chart) — week/month denominator.
// ---------------------------------------------------------------------------

export type UtilisationPeriod = "week" | "month";

/**
 * Average weeks per month (52 / 12). Capacity is stored as a weekly figure
 * (`capacity_hours_per_week`); the workload chart's month view scales BOTH
 * the numerator (allocated hours) and denominator (capacity) by this same
 * factor, so a member's utilisation % is period-invariant — only the
 * absolute hour figures shown change with the selector.
 */
export const WEEKS_PER_MONTH = 52 / 12;

/** Scale factor from a weekly figure to the given period. */
export function periodMultiplier(period: UtilisationPeriod): number {
  return period === "month" ? WEEKS_PER_MONTH : 1;
}

export interface PeriodUtilisation {
  /** Capacity for the period — null when capacity_hours_per_week is null ("not set", never 0). */
  capacityHours: number | null;
  /** Allocated hours for the period — null when capacity_hours_per_week is null (no denominator to derive hours from). */
  allocatedHours: number | null;
  /** True when total allocation exceeds 100% — scale-invariant, same at week or month. */
  isOver: boolean;
}

/**
 * Period-scaled capacity/allocated hours for one member — the input to each
 * bar in the workload chart. Mirrors `memberUtilisation`'s null-capacity
 * contract: a member with no declared capacity gets `null` hours (rendered
 * as "capacity not set" by the caller), never 0 and never Infinity.
 */
export function memberPeriodUtilisation(
  totalAllocationPct: number,
  capacityHoursPerWeek: number | null,
  period: UtilisationPeriod,
): PeriodUtilisation {
  const week = memberUtilisation(totalAllocationPct, capacityHoursPerWeek);
  if (capacityHoursPerWeek == null || week.allocatedHours == null) {
    return { capacityHours: null, allocatedHours: null, isOver: week.isOver };
  }
  const mult = periodMultiplier(period);
  return {
    capacityHours: Math.round(capacityHoursPerWeek * mult * 10) / 10,
    allocatedHours: Math.round(week.allocatedHours * mult * 10) / 10,
    isOver: week.isOver,
  };
}
