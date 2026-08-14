/**
 * GET /audit — filter param mapping. Extracted so
 * GET /api/export?entity=audit (L-27/L-36) reuses the exact same filter
 * application as the list API — a single source of truth so export filters
 * can never drift from list filters.
 */

export type AuditFilters = {
  target_type?: string;
  target_id?: string;
  action?: string;
  actor_id?: string;
};

/** Map query params → a filter descriptor. Unknown params are ignored. */
export function parseAuditFilters(searchParams: URLSearchParams): AuditFilters {
  const filters: AuditFilters = {};
  const targetType = searchParams.get("target_type");
  if (targetType) filters.target_type = targetType;
  const targetId = searchParams.get("target_id");
  if (targetId) filters.target_id = targetId;
  const action = searchParams.get("action");
  if (action) filters.action = action;
  const actorId = searchParams.get("actor_id");
  if (actorId) filters.actor_id = actorId;
  return filters;
}

/** Minimal shape of the Supabase/PostgREST chain steps this filter set uses. */
export type FilterableAuditQuery<Q> = { eq: (col: string, val: unknown) => Q };

export function applyAuditFilters<Q>(query: Q & FilterableAuditQuery<Q>, filters: AuditFilters): Q {
  let q: Q & FilterableAuditQuery<Q> = query;
  if (filters.target_type) q = q.eq("target_type", filters.target_type) as Q & FilterableAuditQuery<Q>;
  if (filters.target_id) q = q.eq("target_id", filters.target_id) as Q & FilterableAuditQuery<Q>;
  if (filters.action) q = q.eq("action", filters.action) as Q & FilterableAuditQuery<Q>;
  if (filters.actor_id) q = q.eq("actor_id", filters.actor_id) as Q & FilterableAuditQuery<Q>;
  return q;
}
