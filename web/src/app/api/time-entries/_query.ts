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
  /** entry_date >= date_from (YYYY-MM-DD, inclusive). L-28/L-30 report + weekly grid. */
  date_from?: string;
  /** entry_date <= date_to (YYYY-MM-DD, inclusive). */
  date_to?: string;
  /** Exact match on the billable flag. Absent = both billable and non-billable rows. */
  billable?: boolean;
};

/** Map query params → a filter descriptor. Unknown params are ignored. */
export function parseTimeEntryFilters(searchParams: URLSearchParams): TimeEntryFilters {
  const filters: TimeEntryFilters = {};
  const projectId = searchParams.get("project_id");
  if (projectId) filters.project_id = projectId;
  const memberId = searchParams.get("member_id");
  if (memberId) filters.member_id = memberId;
  const dateFrom = searchParams.get("date_from");
  if (dateFrom) filters.date_from = dateFrom;
  const dateTo = searchParams.get("date_to");
  if (dateTo) filters.date_to = dateTo;
  const billable = searchParams.get("billable");
  if (billable === "true") filters.billable = true;
  else if (billable === "false") filters.billable = false;
  return filters;
}

/** Minimal shape of the Supabase/PostgREST chain steps this filter set uses. */
export type FilterableTimeEntryQuery<Q> = {
  eq: (col: string, val: unknown) => Q;
  gte: (col: string, val: unknown) => Q;
  lte: (col: string, val: unknown) => Q;
};

export function applyTimeEntryFilters<Q>(
  query: Q & FilterableTimeEntryQuery<Q>,
  filters: TimeEntryFilters,
): Q {
  let q: Q & FilterableTimeEntryQuery<Q> = query;
  if (filters.project_id) q = q.eq("project_id", filters.project_id) as Q & FilterableTimeEntryQuery<Q>;
  if (filters.member_id) q = q.eq("member_id", filters.member_id) as Q & FilterableTimeEntryQuery<Q>;
  if (filters.date_from) q = q.gte("entry_date", filters.date_from) as Q & FilterableTimeEntryQuery<Q>;
  if (filters.date_to) q = q.lte("entry_date", filters.date_to) as Q & FilterableTimeEntryQuery<Q>;
  if (filters.billable !== undefined) q = q.eq("billable", filters.billable) as Q & FilterableTimeEntryQuery<Q>;
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
