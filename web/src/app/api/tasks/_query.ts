/**
 * GET /api/tasks — filter param mapping (L-04/L-08).
 * Pure(ish) helpers extracted from the route so the whitelist, param
 * mapping, and chain construction are unit-testable without a live
 * Supabase connection (mock the chain — see _query.test.ts).
 */

// Sort whitelist for GET /api/tasks (L-10) — reject anything else with 422.
export const TASK_SORT_FIELDS = [
  "due_date",
  "priority",
  "status_type",
  "name",
  "created_at",
  "completion_pct",
] as const;

export type TaskFilters = {
  project_id?: string;
  assignee_id?: string;
  status_type?: string;
  priority?: string;
  due_before?: string;
  due_after?: string;
  overdue?: boolean;
  q?: string;
  // ── complement seam (0041, R-81) — exact-match filters ───────────────────────
  source?: string;
  external_ref?: string;
};

/** Map GET /api/tasks query params → a filter descriptor. Unknown params are ignored. */
export function parseTaskFilters(searchParams: URLSearchParams): TaskFilters {
  const filters: TaskFilters = {};

  const projectId = searchParams.get("project_id");
  if (projectId) filters.project_id = projectId;

  const assigneeId = searchParams.get("assignee_id");
  if (assigneeId) filters.assignee_id = assigneeId;

  const statusType = searchParams.get("status_type");
  if (statusType) filters.status_type = statusType;

  const priority = searchParams.get("priority");
  if (priority) filters.priority = priority;

  const dueBefore = searchParams.get("due_before");
  if (dueBefore) filters.due_before = dueBefore;

  const dueAfter = searchParams.get("due_after");
  if (dueAfter) filters.due_after = dueAfter;

  if (searchParams.get("overdue") === "true") filters.overdue = true;

  const q = searchParams.get("q");
  if (q) filters.q = q;

  const source = searchParams.get("source");
  if (source) filters.source = source;

  const externalRef = searchParams.get("external_ref");
  if (externalRef) filters.external_ref = externalRef;

  return filters;
}

/** Minimal shape of the Supabase/PostgREST chain steps this filter set uses. */
export type FilterableTaskQuery<Q> = {
  eq: (col: string, val: unknown) => Q;
  ilike: (col: string, val: string) => Q;
  lte: (col: string, val: string) => Q;
  gte: (col: string, val: string) => Q;
  lt: (col: string, val: string) => Q;
  not: (col: string, op: string, val: string) => Q;
};

/**
 * Apply parsed filters onto a query-builder chain. `todayIso` (YYYY-MM-DD) is
 * passed in rather than computed here so `overdue=true` is deterministic in
 * tests. overdue excludes completed/canceled tasks (a done task past its due
 * date isn't "overdue" — same idiom as the My Tasks bridge query).
 */
export function applyTaskFilters<Q>(
  query: Q & FilterableTaskQuery<Q>,
  filters: TaskFilters,
  todayIso: string,
): Q {
  let q: Q & FilterableTaskQuery<Q> = query;
  if (filters.project_id) q = q.eq("project_id", filters.project_id) as Q & FilterableTaskQuery<Q>;
  if (filters.assignee_id) q = q.eq("assignee_id", filters.assignee_id) as Q & FilterableTaskQuery<Q>;
  if (filters.status_type) q = q.eq("status_type", filters.status_type) as Q & FilterableTaskQuery<Q>;
  if (filters.priority) q = q.eq("priority", filters.priority) as Q & FilterableTaskQuery<Q>;
  if (filters.due_before) q = q.lte("due_date", filters.due_before) as Q & FilterableTaskQuery<Q>;
  if (filters.due_after) q = q.gte("due_date", filters.due_after) as Q & FilterableTaskQuery<Q>;
  if (filters.overdue) {
    q = q.lt("due_date", todayIso) as Q & FilterableTaskQuery<Q>;
    q = q.not("status_type", "in", '("completed","canceled")') as Q & FilterableTaskQuery<Q>;
  }
  if (filters.q) q = q.ilike("name", `%${filters.q}%`) as Q & FilterableTaskQuery<Q>;
  if (filters.source) q = q.eq("source", filters.source) as Q & FilterableTaskQuery<Q>;
  if (filters.external_ref) q = q.eq("external_ref", filters.external_ref) as Q & FilterableTaskQuery<Q>;
  return q;
}
