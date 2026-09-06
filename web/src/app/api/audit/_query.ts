/**
 * GET /audit — filter param mapping. Extracted so
 * GET /api/export?entity=audit (L-27/L-36) reuses the exact same filter
 * application as the list API — a single source of truth so export filters
 * can never drift from list filters.
 *
 * R-85 (audit cursor): `since` and `order` are extracted here the same
 * lenient way as `channel` — an unparsable/unrecognized value is silently
 * dropped rather than thrown, so this function stays usable by BOTH
 * surfaces. GET /audit layers its OWN strict zod validation on top (422 on
 * an unparsable `since` or an `order` outside asc|desc) — appropriate for an
 * interactive/agent-facing list endpoint; GET /api/export?entity=audit has
 * no such layer and simply ignores a malformed value, exactly like it
 * already does for an unrecognized `channel` — so a bad export query param
 * degrades to "filter not applied" rather than a failed download. Both
 * valid values ARE applied to the export query (see fetchAuditRows in
 * export/route.ts) — export stays consistent with the list API rather than
 * silently dropping a filter that would otherwise work everywhere else.
 * `after_id` is NOT part of this type: it needs a DB read (looking up the
 * referenced row's created_at) that only the /audit route performs.
 */

export type AuditFilters = {
  target_type?: string;
  target_id?: string;
  action?: string;
  actor_id?: string;
  channel?: string;
  since?: string;
  order?: "asc" | "desc";
};

/** The only channel values the DB check constraint accepts (R-82). */
const VALID_CHANNELS = new Set(["ui", "api", "cli", "mcp", "assistant"]);

const VALID_ORDERS = new Set(["asc", "desc"]);

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
  const channel = searchParams.get("channel");
  // Validated against the five known channels — an unrecognized value is
  // ignored rather than passed through to a .eq() that would just return
  // zero rows silently.
  if (channel && VALID_CHANNELS.has(channel)) filters.channel = channel;
  const since = searchParams.get("since");
  // Date.parse rejects garbage but accepts any Date-parseable ISO 8601
  // string; an empty string or unparsable value is dropped rather than
  // passed through to a .gte() that would either error or match nothing.
  if (since && !Number.isNaN(Date.parse(since))) filters.since = since;
  const order = searchParams.get("order");
  if (order && VALID_ORDERS.has(order)) filters.order = order as "asc" | "desc";
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
  if (filters.channel) q = q.eq("channel", filters.channel) as Q & FilterableAuditQuery<Q>;
  return q;
}
