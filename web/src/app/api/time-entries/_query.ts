/**
 * GET /time-entries — filter param mapping. Extracted so
 * GET /api/export?entity=time_entries (L-27) reuses the exact same filter
 * application as the list API — a single source of truth so export filters
 * can never drift from list filters. No sort param exists on the list API
 * today (fixed entry_date desc), so none is exposed here either.
 */

export type TimeEntryFilters = {
  project_id?: string;
  member_id?: string;
};

/** Map query params → a filter descriptor. Unknown params are ignored. */
export function parseTimeEntryFilters(searchParams: URLSearchParams): TimeEntryFilters {
  const filters: TimeEntryFilters = {};
  const projectId = searchParams.get("project_id");
  if (projectId) filters.project_id = projectId;
  const memberId = searchParams.get("member_id");
  if (memberId) filters.member_id = memberId;
  return filters;
}

/** Minimal shape of the Supabase/PostgREST chain steps this filter set uses. */
export type FilterableTimeEntryQuery<Q> = { eq: (col: string, val: unknown) => Q };

export function applyTimeEntryFilters<Q>(
  query: Q & FilterableTimeEntryQuery<Q>,
  filters: TimeEntryFilters,
): Q {
  let q: Q & FilterableTimeEntryQuery<Q> = query;
  if (filters.project_id) q = q.eq("project_id", filters.project_id) as Q & FilterableTimeEntryQuery<Q>;
  if (filters.member_id) q = q.eq("member_id", filters.member_id) as Q & FilterableTimeEntryQuery<Q>;
  return q;
}

/**
 * L-29: resolve the billable value for a new time entry.
 * An explicit `billable` on the create payload always wins; when omitted,
 * fall back to the owning project's `default_billable`; if that's somehow
 * absent too (should never happen — the column is NOT NULL DEFAULT true),
 * fail safe to `true` (today's implicit pre-L-29 behavior).
 */
export function resolveBillable(
  explicit: boolean | undefined,
  projectDefaultBillable: boolean | null | undefined,
): boolean {
  if (explicit !== undefined) return explicit;
  if (projectDefaultBillable !== null && projectDefaultBillable !== undefined) {
    return projectDefaultBillable;
  }
  return true;
}
