/**
 * L-15 — dashboard-wide filter (program / project / target-date range).
 *
 * Pure filtering + label logic, kept separate from the RSC page so it's
 * unit-testable without a DB connection. The dashboard page reads these
 * same param keys off `searchParams` and applies `filterDashboardProjects`
 * before deriving every card's numbers — the filter is server-side, and
 * the URL (pushed by `<DashboardFilterBar>`) is the only state.
 */

export interface DashboardFilterableProject {
  id: string;
  program: string | null;
  target_date: string | null;
}

export interface DashboardFilters {
  program?: string;
  project?: string;
  /** ISO date "YYYY-MM-DD" — inclusive lower bound on target_date. */
  dateFrom?: string;
  /** ISO date "YYYY-MM-DD" — inclusive upper bound on target_date. */
  dateTo?: string;
}

/** True when at least one filter field is set. */
export function hasActiveDashboardFilter(filters: DashboardFilters): boolean {
  return Boolean(filters.program || filters.project || filters.dateFrom || filters.dateTo);
}

/**
 * A project must match EVERY set filter field (AND, not OR). A date-range
 * filter excludes projects with no target_date at all — there's nothing to
 * compare, so it can't be confirmed "in range".
 */
export function matchesDashboardFilters<T extends DashboardFilterableProject>(
  project: T,
  filters: DashboardFilters,
): boolean {
  if (filters.program && project.program !== filters.program) return false;
  if (filters.project && project.id !== filters.project) return false;
  if (filters.dateFrom || filters.dateTo) {
    if (!project.target_date) return false;
    if (filters.dateFrom && project.target_date < filters.dateFrom) return false;
    if (filters.dateTo && project.target_date > filters.dateTo) return false;
  }
  return true;
}

export function filterDashboardProjects<T extends DashboardFilterableProject>(
  projects: readonly T[],
  filters: DashboardFilters,
): T[] {
  return projects.filter((p) => matchesDashboardFilters(p, filters));
}

/**
 * Human-readable "active filter" note threaded into every card's subtitle.
 * `null` when no filter is active — callers render nothing in that case.
 */
export function dashboardFilterLabel(
  filters: DashboardFilters,
  opts: { projectLabel?: string } = {},
): string | null {
  const parts: string[] = [];
  if (filters.program) parts.push(`Program: ${filters.program}`);
  if (filters.project) parts.push(`Project: ${opts.projectLabel ?? filters.project}`);
  if (filters.dateFrom || filters.dateTo) {
    parts.push(`Target: ${filters.dateFrom ?? "…"} – ${filters.dateTo ?? "…"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
