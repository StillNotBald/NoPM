/**
 * GET /projects/:id/issues — filter + sort param mapping (L-08).
 * Extracted so GET /api/export?entity=issues (L-27) reuses the exact same
 * whitelist and filter application as the list API — a single source of
 * truth so export filters can never drift from list filters.
 */

// Sort whitelist for GET /projects/:id/issues (L-10) — same idiom as /api/tasks.
export const ISSUE_SORT_FIELDS = ["due_date", "priority", "severity", "status", "title", "created_at"] as const;

export type IssueFilters = {
  status?: string;
  severity?: string;
  priority?: string;
  // ── complement seam (0041, R-81) — exact-match filters ───────────────────────
  source?: string;
  external_ref?: string;
};

/** Map query params → a filter descriptor. Unknown params are ignored. */
export function parseIssueFilters(searchParams: URLSearchParams): IssueFilters {
  const filters: IssueFilters = {};
  const status = searchParams.get("status");
  if (status) filters.status = status;
  const severity = searchParams.get("severity");
  if (severity) filters.severity = severity;
  const priority = searchParams.get("priority");
  if (priority) filters.priority = priority;
  const source = searchParams.get("source");
  if (source) filters.source = source;
  const externalRef = searchParams.get("external_ref");
  if (externalRef) filters.external_ref = externalRef;
  return filters;
}

/** Minimal shape of the Supabase/PostgREST chain steps this filter set uses. */
export type FilterableIssueQuery<Q> = { eq: (col: string, val: unknown) => Q };

export function applyIssueFilters<Q>(query: Q & FilterableIssueQuery<Q>, filters: IssueFilters): Q {
  let q: Q & FilterableIssueQuery<Q> = query;
  if (filters.status) q = q.eq("status", filters.status) as Q & FilterableIssueQuery<Q>;
  if (filters.severity) q = q.eq("severity", filters.severity) as Q & FilterableIssueQuery<Q>;
  if (filters.priority) q = q.eq("priority", filters.priority) as Q & FilterableIssueQuery<Q>;
  if (filters.source) q = q.eq("source", filters.source) as Q & FilterableIssueQuery<Q>;
  if (filters.external_ref) q = q.eq("external_ref", filters.external_ref) as Q & FilterableIssueQuery<Q>;
  return q;
}
