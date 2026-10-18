/**
 * /risks URL-state whitelist. The register toolbar writes these params; the
 * server page reads them and applies the SAME filters/sort to its
 * workspace-scoped (RLS) Supabase query. Anything not listed here is ignored.
 * Sort fields mirror RISK_SORT_FIELDS in @/app/api/risks/_query.
 */
export const RISK_STATUSES = ["open", "mitigating", "closed", "accepted"] as const;
export const RISK_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const RISK_SORT_FIELDS = ["due_date", "severity", "likelihood", "status", "title", "created_at"] as const;

export type RiskSortField = (typeof RISK_SORT_FIELDS)[number];

export interface RiskPageParams {
  q?: string;
  status?: string;
  severity?: string;
  project_id?: string;
  sort?: { field: RiskSortField; ascending: boolean };
}

type Raw = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRiskPageParams(raw: Raw): RiskPageParams {
  const out: RiskPageParams = {};
  const q = first(raw.q);
  if (q) out.q = q.slice(0, 100);
  const status = first(raw.status);
  if (status && (RISK_STATUSES as readonly string[]).includes(status)) out.status = status;
  const severity = first(raw.severity);
  if (severity && (RISK_SEVERITIES as readonly string[]).includes(severity)) out.severity = severity;
  const projectId = first(raw.project_id);
  if (projectId && UUID.test(projectId)) out.project_id = projectId;
  const sort = first(raw.sort);
  if (sort) {
    const [field, dir] = sort.split(":");
    if ((RISK_SORT_FIELDS as readonly string[]).includes(field) && (dir === "asc" || dir === "desc")) {
      out.sort = { field: field as RiskSortField, ascending: dir === "asc" };
    }
  }
  return out;
}

/** Same filters/sort as the page query, as a GET /api/export?entity=risks href. */
export function riskExportHref(p: RiskPageParams): string {
  const qs = new URLSearchParams({ entity: "risks" });
  if (p.q) qs.set("q", p.q);
  if (p.status) qs.set("status", p.status);
  if (p.severity) qs.set("severity", p.severity);
  if (p.project_id) qs.set("project_id", p.project_id);
  if (p.sort) qs.set("sort", `${p.sort.field}:${p.sort.ascending ? "asc" : "desc"}`);
  return `/api/export?${qs.toString()}`;
}
