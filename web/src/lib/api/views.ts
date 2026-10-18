/**
 * Lean list payloads (audit gaps A7 / K5, R-129).
 *
 * List routes return a SUMMARY column set by default (`view=summary`). A caller
 * that needs every column asks for `view=full`; a caller that needs a few
 * columns asks for `fields=a,b,c`, validated against the entity's allow-list
 * (an unknown field is a 422, never silently dropped). `GET /api/<entity>/:id`
 * always returns the full row.
 *
 * One column list per entity lives here so the routes, the MCP tools and the
 * docs cannot drift apart.
 */

import { RuleError } from "@/lib/api/errors";

export type ViewEntity = "projects" | "tasks" | "milestones" | "risks" | "issues";

/** Columns a caller may pick with `fields=` (and what `view=full` returns). */
export const FULL_COLUMNS: Record<ViewEntity, readonly string[]> = {
  projects: [
    "id", "workspace_id", "code", "name", "description", "program", "program_id", "owner_id", "rag_status",
    "completion_pct", "start_date", "target_date", "currency", "is_locked", "locked_by", "locked_at",
    "lock_reason", "locked_by_actor_type", "locked_by_actor_id", "locked_by_label", "created_at", "updated_at", "business_case", "objective", "scope_summary", "sponsor",
    "project_manager", "phase", "health_commentary", "baseline_start_date", "baseline_target_date",
    "default_billable", "source", "external_ref", "external_url",
  ],
  tasks: [
    "id", "workspace_id", "project_id", "milestone_id", "name", "description", "status", "status_type",
    "assignee_id", "priority", "start_date", "due_date", "completion_pct", "sort_order", "created_at",
    "updated_at", "acceptance_criteria", "estimate_hours", "story_points", "labels", "blocked_by", "checklist",
    "baseline_start_date", "baseline_due_date", "sprint_id", "source", "external_ref", "external_url",
    "content_updated_at",
  ],
  milestones: [
    "id", "workspace_id", "project_id", "name", "description", "deliverable", "start_date", "target_date",
    "baseline_target_date", "actual_date", "status", "completion_pct", "owner_id", "sort_order", "created_at",
    "updated_at",
  ],
  // risks.category (legacy free text) is deliberately absent: deprecated by 0090.
  risks: [
    "id", "workspace_id", "project_id", "reference_id", "title", "description", "severity", "likelihood",
    "mitigation", "owner_id", "status", "raised_at", "due_date", "created_at", "updated_at", "probability_pct",
    "impact_score", "response_strategy", "risk_category", "impact_area", "impact_areas", "trigger",
    "residual_risk", "resolution", "source", "external_ref", "external_url",
  ],
  issues: [
    "id", "workspace_id", "project_id", "reference_id", "title", "description", "priority", "severity",
    "issue_category", "impact", "resolution", "resolution_eta", "resolved_at", "owner_id", "status",
    "raised_at", "due_date", "created_at", "updated_at", "source", "external_ref", "external_url",
  ],
};

/** The default list payload: enough to scan, filter and link; no long text, no lock detail, no seam columns. */
export const SUMMARY_COLUMNS: Record<ViewEntity, readonly string[]> = {
  projects: [
    "id", "code", "name", "rag_status", "owner_id", "program_id", "phase", "start_date", "target_date",
    "completion_pct", "is_locked", "updated_at",
  ],
  tasks: [
    "id", "project_id", "milestone_id", "name", "status", "status_type", "priority", "assignee_id",
    "start_date", "due_date", "completion_pct", "estimate_hours", "sprint_id", "blocked_by", "sort_order",
    "updated_at",
  ],
  milestones: [
    "id", "project_id", "name", "status", "target_date", "completion_pct", "owner_id", "sort_order", "updated_at",
  ],
  risks: [
    "id", "reference_id", "project_id", "title", "severity", "likelihood", "status", "risk_category",
    "impact_areas", "owner_id", "due_date", "updated_at",
  ],
  issues: [
    "id", "reference_id", "project_id", "title", "severity", "priority", "status", "issue_category",
    "owner_id", "due_date", "updated_at",
  ],
};

export type ListView = "summary" | "full";

export type ListSelection = {
  /** PostgREST select string. */
  select: string;
  view: ListView | "fields";
};

/**
 * Resolve `view` / `fields` query params into a select string.
 * - `fields` wins over `view`; `id` is always included.
 * - `view=full` is `*` except for risks, which use an explicit list so the
 *   deprecated `category` column is never returned.
 */
export function parseListSelection(searchParams: URLSearchParams, entity: ViewEntity): ListSelection {
  const rawView = searchParams.get("view");
  const rawFields = searchParams.get("fields");

  if (rawView !== null && rawView !== "summary" && rawView !== "full") {
    throw new RuleError(`Invalid view "${rawView}". Must be "summary" or "full"`);
  }

  if (rawFields !== null && rawFields.trim() !== "") {
    const allowed = FULL_COLUMNS[entity];
    const wanted = rawFields.split(",").map((f) => f.trim()).filter(Boolean);
    const unknown = wanted.filter((f) => !allowed.includes(f));
    if (unknown.length > 0) {
      throw new RuleError(
        `Unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((f) => `"${f}"`).join(", ")} for ${entity}. ` +
          `Allowed: ${allowed.join(", ")}`,
      );
    }
    const unique = Array.from(new Set(["id", ...wanted]));
    return { select: unique.join(","), view: "fields" };
  }

  if (rawView === "full") {
    return { select: entity === "risks" ? FULL_COLUMNS.risks.join(",") : "*", view: "full" };
  }
  return { select: SUMMARY_COLUMNS[entity].join(","), view: "summary" };
}

/** Explicit full-row select for the risks routes (single GET, PATCH, POST): everything except legacy `category`. */
// Typed as "*" on purpose: supabase-js only infers row types from a string LITERAL, and a joined
// string would make every row property "GenericStringError". The runtime value is the explicit list.
export const RISK_SELECT = FULL_COLUMNS.risks.join(",") as "*";
