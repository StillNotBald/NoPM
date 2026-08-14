/**
 * GET /projects/:id/risks — filter + sort param mapping (L-08).
 * Extracted so GET /api/export?entity=risks (L-27) reuses the exact same
 * whitelist and filter application as the list API — a single source of
 * truth so export filters can never drift from list filters.
 */

// Sort whitelist for GET /projects/:id/risks (L-10) — same idiom as /api/tasks.
export const RISK_SORT_FIELDS = ["due_date", "severity", "likelihood", "status", "title", "created_at"] as const;

export type RiskFilters = {
  status?: string;
  severity?: string;
};

/** Map query params → a filter descriptor. Unknown params are ignored. */
export function parseRiskFilters(searchParams: URLSearchParams): RiskFilters {
  const filters: RiskFilters = {};
  const status = searchParams.get("status");
  if (status) filters.status = status;
  const severity = searchParams.get("severity");
  if (severity) filters.severity = severity;
  return filters;
}

/** Minimal shape of the Supabase/PostgREST chain steps this filter set uses. */
export type FilterableRiskQuery<Q> = { eq: (col: string, val: unknown) => Q };

export function applyRiskFilters<Q>(query: Q & FilterableRiskQuery<Q>, filters: RiskFilters): Q {
  let q: Q & FilterableRiskQuery<Q> = query;
  if (filters.status) q = q.eq("status", filters.status) as Q & FilterableRiskQuery<Q>;
  if (filters.severity) q = q.eq("severity", filters.severity) as Q & FilterableRiskQuery<Q>;
  return q;
}
