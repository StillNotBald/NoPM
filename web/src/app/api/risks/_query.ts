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
  // ── complement seam (0041, R-81) — exact-match filters ───────────────────────
  source?: string;
  external_ref?: string;
};

/** Map query params → a filter descriptor. Unknown params are ignored. */
export function parseRiskFilters(searchParams: URLSearchParams): RiskFilters {
  const filters: RiskFilters = {};
  const status = searchParams.get("status");
  if (status) filters.status = status;
  const severity = searchParams.get("severity");
  if (severity) filters.severity = severity;
  const source = searchParams.get("source");
  if (source) filters.source = source;
  const externalRef = searchParams.get("external_ref");
  if (externalRef) filters.external_ref = externalRef;
  return filters;
}

import { RISK_IMPACT_AREAS } from "@/lib/risk/impact-areas";

/**
 * `impact_area=cost,schedule` -> any-of filter (a risk matches when it touches ANY listed area).
 * Unknown values are dropped. Kept out of RiskFilters on purpose: the export route echoes
 * RiskFilters into its metadata and does not apply this one.
 */
export function parseImpactAreaFilter(searchParams: URLSearchParams): string[] {
  const raw = searchParams.get("impact_area");
  if (!raw) return [];
  const wanted = raw.split(",").map((v) => v.trim()).filter(Boolean);
  return Array.from(new Set(wanted.filter((v) => (RISK_IMPACT_AREAS as readonly string[]).includes(v))));
}

/** Minimal shape of the Supabase/PostgREST chain steps this filter set uses. */
export type FilterableRiskQuery<Q> = { eq: (col: string, val: unknown) => Q };

export function applyRiskFilters<Q>(query: Q & FilterableRiskQuery<Q>, filters: RiskFilters): Q {
  let q: Q & FilterableRiskQuery<Q> = query;
  if (filters.status) q = q.eq("status", filters.status) as Q & FilterableRiskQuery<Q>;
  if (filters.severity) q = q.eq("severity", filters.severity) as Q & FilterableRiskQuery<Q>;
  if (filters.source) q = q.eq("source", filters.source) as Q & FilterableRiskQuery<Q>;
  if (filters.external_ref) q = q.eq("external_ref", filters.external_ref) as Q & FilterableRiskQuery<Q>;
  return q;
}
