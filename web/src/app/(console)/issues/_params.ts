/**
 * /issues URL-state whitelist. The register toolbar writes these params; the
 * server page binds them to its workspace-scoped (RLS) Supabase query. A value
 * that is not a known enum member / UUID is IGNORED (the filter simply isn't
 * applied) instead of reaching `.eq()` — e.g. `?project_id=abc` used to make
 * Postgres reject the uuid cast and crash the whole page into QueryError.
 * Mirrors risks/_params.ts; enums mirror api/issues/_schema.ts.
 */
export const ISSUE_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
export const ISSUE_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const ISSUE_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export interface IssuePageFilters {
  status?: string;
  severity?: string;
  priority?: string;
  project_id?: string;
}

type Raw = Record<string, string | string[] | undefined>;

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseIssuePageFilters(raw: Raw): IssuePageFilters {
  const out: IssuePageFilters = {};
  const status = first(raw.status);
  if (status && (ISSUE_STATUSES as readonly string[]).includes(status)) out.status = status;
  const severity = first(raw.severity);
  if (severity && (ISSUE_SEVERITIES as readonly string[]).includes(severity)) out.severity = severity;
  const priority = first(raw.priority);
  if (priority && (ISSUE_PRIORITIES as readonly string[]).includes(priority)) out.priority = priority;
  const projectId = first(raw.project_id);
  if (projectId && UUID.test(projectId)) out.project_id = projectId;
  return out;
}
