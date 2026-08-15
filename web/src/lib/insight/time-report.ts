/**
 * Time report aggregation (L-28/L-30) — pure rollup over a set of
 * time_entries rows (whatever GET /api/time-entries returned for the
 * caller's current filter/page — see AggregateFooter's "(current page)"
 * honesty convention this mirrors).
 *
 * D14 (locked): cost is summed ONLY from each entry's `cost` snapshot
 * (hours * the member's cost_rate AT THE TIME the entry was logged — see
 * time-entries/route.ts POST). It is NEVER recomputed from a member's
 * CURRENT cost_rate, so a report never silently reprices historical work
 * when a rate changes later. Report totals include non-billable entries by
 * default and always exclude expenses — that combination is the one that
 * reconciles to /budget's labour actual (see recon-time.md §5); switching
 * the billable filter on legitimately diverges from /budget, and the UI
 * caption must say so (D14 UI note — rendered by the caller, not this lib).
 */

export interface TimeEntryForReport {
  id: string;
  member_id: string;
  project_id: string | null;
  hours: number | string | null;
  cost: number | string | null;
  billable: boolean | null;
}

export interface MemberReportTotal {
  member_id: string;
  hours: number;
  billableHours: number;
  nonBillableHours: number;
  cost: number;
}

export interface ProjectReportTotal {
  project_id: string;
  hours: number;
  billableHours: number;
  nonBillableHours: number;
  cost: number;
}

export interface TimeReport {
  byMember: MemberReportTotal[];
  byProject: ProjectReportTotal[];
  entryCount: number;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  /** Sum of entry.cost snapshots only (D14) — never re-derived from a current rate. */
  totalCost: number;
}

function safeNumber(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Aggregate a page of time_entries into member/project totals + grand totals. */
export function aggregateTimeReport(entries: readonly TimeEntryForReport[]): TimeReport {
  const byMemberMap = new Map<string, MemberReportTotal>();
  const byProjectMap = new Map<string, ProjectReportTotal>();

  let totalHours = 0;
  let billableHours = 0;
  let nonBillableHours = 0;
  let totalCost = 0;

  for (const entry of entries) {
    const hours = safeNumber(entry.hours);
    const cost = safeNumber(entry.cost);
    const billable = entry.billable !== false; // null/undefined treated as billable (matches DB default true)

    totalHours += hours;
    totalCost += cost;
    if (billable) billableHours += hours;
    else nonBillableHours += hours;

    let m = byMemberMap.get(entry.member_id);
    if (!m) {
      m = { member_id: entry.member_id, hours: 0, billableHours: 0, nonBillableHours: 0, cost: 0 };
      byMemberMap.set(entry.member_id, m);
    }
    m.hours += hours;
    m.cost += cost;
    if (billable) m.billableHours += hours;
    else m.nonBillableHours += hours;

    if (entry.project_id) {
      let p = byProjectMap.get(entry.project_id);
      if (!p) {
        p = { project_id: entry.project_id, hours: 0, billableHours: 0, nonBillableHours: 0, cost: 0 };
        byProjectMap.set(entry.project_id, p);
      }
      p.hours += hours;
      p.cost += cost;
      if (billable) p.billableHours += hours;
      else p.nonBillableHours += hours;
    }
  }

  function round<T extends { hours: number; billableHours: number; nonBillableHours: number; cost: number }>(
    t: T,
  ): T {
    return {
      ...t,
      hours: round2(t.hours),
      billableHours: round2(t.billableHours),
      nonBillableHours: round2(t.nonBillableHours),
      cost: round2(t.cost),
    };
  }

  return {
    byMember: [...byMemberMap.values()].map(round),
    byProject: [...byProjectMap.values()].map(round),
    entryCount: entries.length,
    totalHours: round2(totalHours),
    billableHours: round2(billableHours),
    nonBillableHours: round2(nonBillableHours),
    totalCost: round2(totalCost),
  };
}
