import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { workspaceToday } from "@/lib/integrations/time-zone";
import { toCsv } from "@/lib/export/csv";
import {
  CHANGE_REQUEST_COLUMNS, AUDIT_PACK_COLUMNS, auditPackCsvRows, fetchChangeRequestRows,
  changeRequestRangeFilter, gatherAuditPack, profileLabels, type ExportDb,
} from "@/lib/export/audit-pack";
import { renderAuditPackPdf } from "@/lib/reports/pdf";
import { RISK_SELECT } from "@/lib/api/views";
import { parseSort, orderOptions } from "@/lib/api/sort";
import { TASK_SORT_FIELDS, parseTaskFilters } from "@/app/api/tasks/_query";
import { RISK_SORT_FIELDS, parseRiskFilters, parseImpactAreaFilter } from "@/app/api/risks/_query";
import { ISSUE_SORT_FIELDS, parseIssueFilters } from "@/app/api/issues/_query";
import { parseAuditFilters } from "@/app/api/audit/_query";
import { assertCanListMembers, memberMfaEnabled } from "@/lib/people/members";
import { parseExportRange, assertRangeOrder, rangeColumn, applyExportRange, type ExportRange } from "./_audit-range";

export const runtime = "nodejs";

/**
 * GET /api/export — governed CSV export (L-27, L-36).
 *
 * The export is a READ over an already-governed entity, but exporting the
 * audit log itself must still show up IN the audit log (L-36) — so this
 * route writes exactly one fail-closed audit row per export, action
 * `export.csv`, regardless of which entity was exported.
 *
 * Filter/sort PARSING is shared with each entity's list API (imports above)
 * — a single source of truth for which query params are honored, so export
 * filters can never silently drift from list filters. Each entity is
 * fetched by its own small dedicated function below (rather than one big
 * switch) — combining several of these generic Supabase query builders
 * inside a single function body pushes TypeScript's type-instantiation
 * depth past its limit (TS2589); splitting into one function per entity,
 * mirroring how each list route is its own file, avoids that.
 *
 * Capped at MAX_EXPORT_ROWS rows; if the true match count exceeds the cap,
 * a final row notes the truncation (and it's logged server-side) rather
 * than silently dropping data.
 */

const MAX_EXPORT_ROWS = 10_000;
/** Ids per .in() lookup, so a 10,000-row export never builds an oversized URL. */
const ID_CHUNK = 100;

const ENTITY_SCOPES = {
  tasks: "task:read",
  risks: "risk:read",
  issues: "issue:read",
  clashes: "clash:read",
  audit: "audit:read",
  programs: "program:read",
  projects: "project:read",
  change_requests: "change:read",
} as const;

/**
 * Access-review entities (M5). There is no read scope for people, tokens or
 * connector identities: GET /api/members and GET /api/tokens are admin or
 * manager SESSION only, so these exports follow the same rule. A token
 * (whatever its scopes) or a member/viewer session gets 403.
 */
const ADMIN_ENTITIES = ["members", "tokens", "identities"] as const;
type AdminEntity = (typeof ADMIN_ENTITIES)[number];

type ScopedEntity = keyof typeof ENTITY_SCOPES;
type Entity = ScopedEntity | AdminEntity;

/** Entities that carry an updated_at, so `on=updated` can filter on it. */
const HAS_UPDATED_AT: ReadonlySet<Entity> = new Set<Entity>([
  "tasks", "risks", "issues", "clashes", "projects", "change_requests",
]);

function isAdminEntity(e: Entity): e is AdminEntity {
  return (ADMIN_ENTITIES as readonly string[]).includes(e);
}

/** Column the date range filters on for this entity. */
function rangeColumnFor(entity: Entity, range: ExportRange): string {
  return rangeColumn(range.on, {
    hasUpdatedAt: HAS_UPDATED_AT.has(entity),
    createdColumn: entity === "identities" ? "linked_at" : "created_at",
  });
}

const ENTITY_COLUMNS: Record<Entity, readonly string[]> = {
  change_requests: CHANGE_REQUEST_COLUMNS,
  // M5 access review. Email is exported because GET /api/members returns it
  // to the same admin/manager audience. No secrets, no backup codes.
  members: [
    "id", "display_name", "email", "role", "status", "mfa_enabled", "created_at",
    "removed_at", "last_role_change_at", "last_role_change_by",
  ],
  // Never token_hash. The API has no revoked_at, only a revoked flag.
  tokens: [
    "id", "label", "prefix", "scopes", "created_by", "created_by_label",
    "created_at", "expires_at", "revoked", "last_used_at",
  ],
  // Connector identities: profile, provider, linked_at. The external platform
  // user id is deliberately not exported.
  identities: [
    "id", "profile_id", "profile_label", "provider", "connector_id", "linked_at",
    "revoked_at",
  ],
  tasks: [
    "id", "workspace_id", "project_id", "milestone_id", "name", "description",
    "status", "status_type", "assignee_id", "priority", "start_date", "due_date",
    "completion_pct", "sort_order", "created_at", "updated_at",
  ],
  risks: [
    "id", "workspace_id", "project_id", "reference_id", "title", "description",
    "severity", "likelihood", "risk_category", "impact_areas", "mitigation", "owner_id",
    "status", "raised_at", "due_date", "created_at", "updated_at",
  ],
  issues: [
    "id", "workspace_id", "project_id", "reference_id", "title", "description",
    "priority", "resolution", "owner_id", "status", "raised_at", "due_date",
    "created_at", "updated_at",
  ],
  clashes: [
    "id", "workspace_id", "reference_id", "title", "type", "severity",
    "project_a_id", "project_b_id", "resource_member_id", "window_start",
    "window_end", "status", "owner_id", "resolution", "created_at", "updated_at",
  ],
  audit: [
    "id", "workspace_id", "actor_type", "actor_id", "actor_label", "action",
    "target_type", "target_id", "before", "after", "channel", "request_id",
    "created_at",
    // M3 provenance: who really acted (principal), through which connector.
    "principal_id", "principal_label", "via_connector_id", "external_event_id",
    "external_actor_ref",
    // R-154 tamper evidence: the row hash lets an auditor recompute the chain offline.
    "row_hash",
  ],
  programs: [
    "id", "workspace_id", "code", "name", "rag_status", "owner_id", "created_at",
  ],
  projects: [
    "id", "workspace_id", "code", "name", "description", "program", "program_id",
    "owner_id", "rag_status", "phase", "completion_pct", "start_date", "target_date",
    "currency", "is_locked", "sponsor", "project_manager", "created_at", "updated_at",
  ],
};

/** Sort whitelist for entity=projects (GET /projects has a fixed created_at desc order). */
const PROJECT_SORT_FIELDS = ["name", "code", "rag_status", "phase", "completion_pct", "target_date", "created_at"] as const;

/** Free-text search term — same `%q%` ilike shape the tasks export uses. */
function ilikeTerm(q: string): string {
  return `%${q}%`;
}

function isEntity(value: string | null): value is Entity {
  return (
    !!value &&
    (Object.prototype.hasOwnProperty.call(ENTITY_SCOPES, value) ||
      (ADMIN_ENTITIES as readonly string[]).includes(value))
  );
}

type Db = ReturnType<typeof createAdminClient>;

type FetchResult = {
  rows: Record<string, unknown>[];
  total: number;
  filters: Record<string, unknown>;
};

async function fetchTasksRows(
  sp: URLSearchParams,
  workspaceId: string,
  db: Db,
  todayIso: string,
  range: ExportRange,
): Promise<FetchResult> {
  const sort = parseSort(sp.get("sort"), TASK_SORT_FIELDS, { field: "due_date", ascending: true });
  const filters = parseTaskFilters(sp);
  let query = db.from("tasks").select("*", { count: "exact" }).eq("workspace_id", workspaceId);
  // Applied inline rather than via the generic applyTaskFilters<Q> helper
  // (same TS2589 workaround as the other fetch* functions below) —
  // parseTaskFilters is still the single source of truth for which params
  // are honored; only the mechanical .eq()/.ilike()/.lte()/etc. application
  // is duplicated.
  if (filters.project_id) query = query.eq("project_id", filters.project_id);
  if (filters.assignee_id) query = query.eq("assignee_id", filters.assignee_id);
  if (filters.status_type) query = query.eq("status_type", filters.status_type);
  if (filters.priority) query = query.eq("priority", filters.priority);
  if (filters.due_before) query = query.lte("due_date", filters.due_before);
  if (filters.due_after) query = query.gte("due_date", filters.due_after);
  if (filters.overdue) {
    query = query.lt("due_date", todayIso).not("status_type", "in", '("completed","canceled")');
  }
  if (filters.q) query = query.ilike("name", `%${filters.q}%`);
  query = applyExportRange(query, range, rangeColumnFor("tasks", range));
  const { data, error, count } = await query
    .order(sort.field, orderOptions(sort))
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  return {
    rows: (data ?? []) as Record<string, unknown>[],
    total: count ?? (data ?? []).length,
    filters: { ...filters, sort: sp.get("sort") ?? undefined, ...rangeFilters(range) },
  };
}

async function assertProjectInWorkspace(db: Db, projectId: string, workspaceId: string): Promise<void> {
  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!project) throw new NotFoundError("Project not found");
}

async function fetchRisksRows(
  sp: URLSearchParams,
  workspaceId: string,
  db: Db,
  range: ExportRange,
): Promise<FetchResult> {
  // project_id is OPTIONAL: given -> that project's risks (validated in-workspace);
  // omitted -> every risk in the actor's workspace (cross-project register).
  const projectId = sp.get("project_id");
  if (projectId) await assertProjectInWorkspace(db, projectId, workspaceId);

  const sort = parseSort(sp.get("sort"), RISK_SORT_FIELDS, { field: "created_at", ascending: false });
  const filters = parseRiskFilters(sp);
  const q = sp.get("q")?.trim() || undefined;
  let query = db.from("risks").select(RISK_SELECT, { count: "exact" }).eq("workspace_id", workspaceId);
  if (projectId) query = query.eq("project_id", projectId);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.severity) query = query.eq("severity", filters.severity);
  if (q) query = query.ilike("title", ilikeTerm(q));
  // Any-of impact area, same as the list route (a risk matches if it touches ANY listed area).
  const impactAreas = parseImpactAreaFilter(sp);
  if (impactAreas.length > 0) {
    query = (query as unknown as { overlaps(c: string, v: string[]): typeof query }).overlaps("impact_areas", impactAreas);
  }
  query = applyExportRange(query, range, rangeColumnFor("risks", range));
  const { data, error, count } = await query
    .order(sort.field, orderOptions(sort))
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  const riskRows = (data ?? []) as Record<string, unknown>[];
  for (const r of riskRows) {
    if (Array.isArray(r.impact_areas)) r.impact_areas = (r.impact_areas as string[]).join(" ");
  }
  return {
    rows: riskRows,
    total: count ?? riskRows.length,
    filters: {
      project_id: projectId ?? undefined, ...filters, q, sort: sp.get("sort") ?? undefined,
      impact_area: impactAreas.length > 0 ? impactAreas : undefined, ...rangeFilters(range),
    },
  };
}

async function fetchIssuesRows(
  sp: URLSearchParams,
  workspaceId: string,
  db: Db,
  range: ExportRange,
): Promise<FetchResult> {
  // project_id OPTIONAL — same posture as fetchRisksRows.
  const projectId = sp.get("project_id");
  if (projectId) await assertProjectInWorkspace(db, projectId, workspaceId);

  const sort = parseSort(sp.get("sort"), ISSUE_SORT_FIELDS, { field: "created_at", ascending: false });
  const filters = parseIssueFilters(sp);
  const q = sp.get("q")?.trim() || undefined;
  let query = db.from("issues").select("*", { count: "exact" }).eq("workspace_id", workspaceId);
  if (projectId) query = query.eq("project_id", projectId);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.severity) query = query.eq("severity", filters.severity);
  if (filters.priority) query = query.eq("priority", filters.priority);
  if (q) query = query.ilike("title", ilikeTerm(q));
  query = applyExportRange(query, range, rangeColumnFor("issues", range));
  const { data, error, count } = await query
    .order(sort.field, orderOptions(sort))
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  return {
    rows: (data ?? []) as Record<string, unknown>[],
    total: count ?? (data ?? []).length,
    filters: { project_id: projectId ?? undefined, ...filters, q, sort: sp.get("sort") ?? undefined, ...rangeFilters(range) },
  };
}

async function fetchClashesRows(workspaceId: string, db: Db, range: ExportRange): Promise<FetchResult> {
  // GET /clashes takes no filter/sort params — export mirrors that: fixed created_at desc.
  const base = db.from("clashes").select("*", { count: "exact" }).eq("workspace_id", workspaceId);
  const { data, error, count } = await applyExportRange(base, range, rangeColumnFor("clashes", range))
    .order("created_at", { ascending: false })
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  return {
    rows: (data ?? []) as Record<string, unknown>[],
    total: count ?? (data ?? []).length,
    filters: rangeFilters(range),
  };
}

async function fetchProjectsRows(
  sp: URLSearchParams,
  workspaceId: string,
  db: Db,
  range: ExportRange,
): Promise<FetchResult> {
  const sort = parseSort(sp.get("sort"), PROJECT_SORT_FIELDS, { field: "created_at", ascending: false });
  const q = sp.get("q")?.trim() || undefined;
  const ragStatus = sp.get("rag_status") || undefined;
  const phase = sp.get("phase") || undefined;
  const programId = sp.get("program_id") || undefined;
  let query = db.from("projects").select("*", { count: "exact" }).eq("workspace_id", workspaceId);
  if (ragStatus) query = query.eq("rag_status", ragStatus);
  if (phase) query = query.eq("phase", phase);
  if (programId) query = query.eq("program_id", programId);
  if (q) query = query.ilike("name", ilikeTerm(q));
  query = applyExportRange(query, range, rangeColumnFor("projects", range));
  const { data, error, count } = await query
    .order(sort.field, orderOptions(sort))
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  return {
    rows: (data ?? []) as Record<string, unknown>[],
    total: count ?? (data ?? []).length,
    filters: {
      rag_status: ragStatus, phase, program_id: programId, q, sort: sp.get("sort") ?? undefined,
      ...rangeFilters(range),
    },
  };
}

async function fetchProgramsRows(workspaceId: string, db: Db, range: ExportRange): Promise<FetchResult> {
  // GET /programs takes no filter/sort params today — export mirrors that:
  // fixed name asc, same posture as fetchClashesRows above.
  const base = db.from("programs").select("*", { count: "exact" }).eq("workspace_id", workspaceId);
  const { data, error, count } = await applyExportRange(base, range, rangeColumnFor("programs", range))
    .order("name", { ascending: true })
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  return {
    rows: (data ?? []) as Record<string, unknown>[],
    total: count ?? (data ?? []).length,
    filters: rangeFilters(range),
  };
}

async function fetchAuditRows(
  sp: URLSearchParams,
  workspaceId: string,
  db: Db,
  range: ExportRange,
): Promise<FetchResult> {
  const filters = parseAuditFilters(sp);
  let query = db.from("audit_log").select("*", { count: "exact" }).eq("workspace_id", workspaceId);
  // Same TS2589 workaround as GET /audit — inline .eq() instead of the
  // generic applyAuditFilters<Q> helper; parseAuditFilters is still the
  // single source of truth for which params are honored.
  if (filters.target_type !== undefined) query = query.eq("target_type", filters.target_type);
  if (filters.target_id !== undefined) query = query.eq("target_id", filters.target_id);
  if (filters.action !== undefined) query = query.eq("action", filters.action);
  if (filters.actor_id !== undefined) query = query.eq("actor_id", filters.actor_id);
  if (filters.channel !== undefined) query = query.eq("channel", filters.channel);
  // R-85 (audit cursor): `since`/`order` are applied here too — a
  // DELIBERATE decision to keep this export consistent with GET /audit
  // rather than "unchanged" meaning "these two params do nothing here".
  // parseAuditFilters is lenient (an unparsable `since` or unrecognized
  // `order` is silently dropped, same as an unrecognized `channel` already
  // is) rather than 422ing, since a CSV download has no per-field error
  // channel to report through — a bad value just fails to narrow/reorder
  // the export instead of failing the download. `after_id` is
  // deliberately NOT supported here: it requires the row-lookup that only
  // the interactive /audit route performs.
  if (filters.since !== undefined) query = query.gte("created_at", filters.since);
  // `from` / `to` (UTC calendar days, inclusive) — what the Trust Center date
  // filter writes, so the downloaded file matches the on-screen view. `from` is
  // a day-granular alias of `since` (both may be given; both narrow). Malformed
  // days are dropped, same leniency as `since`.
  query = applyExportRange(query, range, "created_at");
  const { data, error, count } = await query
    .order("created_at", { ascending: filters.order === "asc" })
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  // principal_label: ONE profiles lookup for every distinct principal on the
  // page (no N+1). Unknown principals (deleted profile, system) stay blank.
  const labels = await profileLabels(
    db as unknown as ExportDb,
    workspaceId,
    rows.map((r) => r.principal_id),
  );
  for (const r of rows) {
    r.principal_label = typeof r.principal_id === "string" ? (labels.get(r.principal_id) ?? "") : "";
  }
  return {
    rows,
    total: count ?? rows.length,
    filters: { ...filters, ...rangeFilters(range) },
  };
}

/** The range as it is recorded in the export.csv audit row. */
function rangeFilters(range: ExportRange): Record<string, unknown> {
  return { from: range.from, to: range.to, on: range.from || range.to ? range.on : undefined };
}

async function fetchChangeRequestsRows(workspaceId: string, db: Db, range: ExportRange): Promise<FetchResult> {
  // Same selection rule as the audit pack (raised, decided or implemented in range);
  // on=updated keeps its meaning and filters on updated_at.
  const packFilter = changeRequestRangeFilter(range);
  const { rows, total } = await fetchChangeRequestRows(db as unknown as ExportDb, workspaceId, (q, hasImpl) =>
    range.on === "updated" ? applyExportRange(q, range, "updated_at") : packFilter(q, hasImpl),
  );
  return { rows, total, filters: rangeFilters(range) };
}

async function fetchMembersRows(workspaceId: string, db: Db, range: ExportRange): Promise<FetchResult> {
  // Same columns and workspace filter as GET /api/members (listMembers), plus
  // the date range on profiles.created_at.
  const base = db
    .from("profiles")
    .select("id, email, display_name, role, status, created_at, removed_at", { count: "exact" })
    .eq("workspace_id", workspaceId);
  const { data, error, count } = await applyExportRange(base, range, "created_at")
    .order("created_at", { ascending: true })
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  const ids = rows.map((r) => r.id as string);
  if (ids.length > 0) {
    // Chunked by ID_CHUNK ids so no lookup builds an oversized PostgREST URL.
    const mfa = new Set<string>();
    // Last role change comes from the audit log (member.role_change): newest
    // first, first hit per person wins. Chunks hold disjoint ids.
    const last = new Map<string, { at: unknown; by: unknown }>();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      for (const id of await memberMfaEnabled(chunk)) mfa.add(id);
      const { data: a, error: aErr } = await db
        .from("audit_log")
        .select("target_id, actor_label, created_at")
        .eq("workspace_id", workspaceId)
        .eq("action", "member.role_change")
        .in("target_id", chunk)
        .order("created_at", { ascending: false })
        .limit(MAX_EXPORT_ROWS);
      if (aErr) throw new Error(`Export query failed: ${aErr.message}`);
      for (const x of (a ?? []) as { target_id: string; actor_label: unknown; created_at: unknown }[]) {
        if (!last.has(x.target_id)) last.set(x.target_id, { at: x.created_at, by: x.actor_label });
      }
    }
    for (const r of rows) {
      const id = r.id as string;
      r.mfa_enabled = mfa.has(id);
      r.last_role_change_at = last.get(id)?.at ?? "";
      r.last_role_change_by = last.get(id)?.by ?? "";
    }
  }
  return { rows, total: count ?? rows.length, filters: rangeFilters(range) };
}

async function fetchTokensRows(workspaceId: string, db: Db, range: ExportRange): Promise<FetchResult> {
  // Same inventory as GET /api/tokens: this workspace, the assistant's
  // ephemeral per-turn tokens hidden. token_hash is never selected.
  const base = db
    .from("api_tokens")
    .select("id, name, prefix, scopes, created_by, expires_at, revoked, last_used_at, created_at", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .neq("kind", "assistant");
  const { data, error, count } = await applyExportRange(base, range, "created_at")
    .order("created_at", { ascending: false })
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  const labels = await profileLabels(db as unknown as ExportDb, workspaceId, rows.map((r) => r.created_by));
  for (const r of rows) {
    r.label = r.name;
    r.scopes = Array.isArray(r.scopes) ? (r.scopes as string[]).join(" ") : "";
    r.created_by_label = typeof r.created_by === "string" ? (labels.get(r.created_by) ?? "") : "";
  }
  return { rows, total: count ?? rows.length, filters: rangeFilters(range) };
}

async function fetchIdentitiesRows(workspaceId: string, db: Db, range: ExportRange): Promise<FetchResult> {
  const base = db
    .from("external_identities")
    .select("id, profile_id, provider, connector_id, linked_at, revoked_at", { count: "exact" })
    .eq("workspace_id", workspaceId);
  const { data, error, count } = await applyExportRange(base, range, "linked_at")
    .order("linked_at", { ascending: false })
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  const labels = await profileLabels(db as unknown as ExportDb, workspaceId, rows.map((r) => r.profile_id));
  for (const r of rows) {
    r.profile_label = typeof r.profile_id === "string" ? (labels.get(r.profile_id) ?? "") : "";
  }
  return { rows, total: count ?? rows.length, filters: rangeFilters(range) };
}

async function fetchEntityRows(
  entity: Entity,
  url: URL,
  workspaceId: string,
  db: Db,
  today: string,
): Promise<FetchResult> {
  const sp = url.searchParams;
  const range = parseExportRange(sp);
  assertRangeOrder(range);
  switch (entity) {
    case "tasks":
      return fetchTasksRows(sp, workspaceId, db, today, range);
    case "risks":
      return fetchRisksRows(sp, workspaceId, db, range);
    case "issues":
      return fetchIssuesRows(sp, workspaceId, db, range);
    case "clashes":
      return fetchClashesRows(workspaceId, db, range);
    case "audit":
      return fetchAuditRows(sp, workspaceId, db, range);
    case "programs":
      return fetchProgramsRows(workspaceId, db, range);
    case "projects":
      return fetchProjectsRows(sp, workspaceId, db, range);
    case "change_requests":
      return fetchChangeRequestsRows(workspaceId, db, range);
    case "members":
      return fetchMembersRows(workspaceId, db, range);
    case "tokens":
      return fetchTokensRows(workspaceId, db, range);
    case "identities":
      return fetchIdentitiesRows(workspaceId, db, range);
  }
}

/** Same gate as GET /api/tokens (admin or manager session), but the refusal names the tokens export. */
function assertCanExportTokens(actor: { type: string; role?: string | null }): void {
  if (actor.type !== "user" || !["admin", "manager"].includes(actor.role ?? "")) {
    throw new ScopeError("Exporting tokens requires an admin or manager session");
  }
}

/** The audit pack is for an external auditor: admin or manager SESSION only (a token gets 403). */
function assertCanExportAuditPack(actor: { type: string; role?: string | null }): void {
  if (actor.type !== "user" || !["admin", "manager"].includes(actor.role ?? "")) {
    throw new ScopeError("The audit pack requires an admin or manager session");
  }
}

async function auditPackResponse(
  actor: Parameters<typeof writeAudit>[0]["actor"],
  url: URL,
  today: string,
): Promise<Response> {
  const format = url.searchParams.get("format") ?? "csv";
  if (format !== "csv" && format !== "pdf") throw new RuleError("format must be csv or pdf");
  const range = parseExportRange(url.searchParams);
  assertRangeOrder(range);
  const pack = await gatherAuditPack(
    createAdminClient() as unknown as ExportDb,
    actor.workspaceId,
    range,
    actor.label,
  );

  // Render first: an audit row must not exist for a download that failed to build.
  let body: Uint8Array | string;
  if (format === "pdf") {
    body = new Uint8Array(renderAuditPackPdf(pack));
  } else {
    const csvRows = auditPackCsvRows(pack);
    if (pack.truncated) {
      console.warn(`[nopm] audit pack truncated: workspace=${actor.workspaceId} cap=${MAX_EXPORT_ROWS}`);
      const note: unknown[] = AUDIT_PACK_COLUMNS.map(() => "");
      note[0] = "note";
      note[1] = `# TRUNCATED: a section hit the cap of ${MAX_EXPORT_ROWS} rows. Narrow the date range.`;
      csvRows.push(note);
    }
    body = toCsv([...AUDIT_PACK_COLUMNS], csvRows);
  }

  // Export is a read, but it is audited like every export: one fail-closed row with the range.
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "export.audit_pack",
    targetType: "entity",
    targetId: null,
    before: null,
    after: {
      entity: "audit_pack",
      format,
      row_counts: pack.totals,
      truncated: pack.truncated,
      unavailable: pack.unavailable,
      filters: { from: range.from, to: range.to },
    },
  });

  return new Response(body as BodyInit, {
    headers: {
      "content-type": format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="nopm-audit-pack-${today}.${format}"`,
    },
  });
}

export const GET = route(async ({ actor, request }) => {
  const url = new URL(request.url);
  const entityParam = url.searchParams.get("entity");

  if (entityParam === "audit_pack") {
    assertCanExportAuditPack(actor);
    return auditPackResponse(actor, url, await workspaceToday(actor.workspaceId));
  }

  if (!isEntity(entityParam)) {
    throw new RuleError(
      `entity must be one of: ${[...Object.keys(ENTITY_SCOPES), ...ADMIN_ENTITIES, "audit_pack"].join(", ")}`,
    );
  }
  const entity = entityParam;

  if (isAdminEntity(entity)) {
    // Access review: admin or manager session only (same gate as GET /api/members).
    // UAT-030: the tokens export is admin or manager (same as GET /api/tokens); its refusal names the tokens export.
    if (entity === "tokens") assertCanExportTokens(actor);
    else assertCanListMembers(actor);
  } else {
    requireScope(actor, ENTITY_SCOPES[entity]);
  }

  const db = createAdminClient();
  const columns = ENTITY_COLUMNS[entity];

  // Server-derived date in the workspace zone (filename + overdue cut-off) — NEVER from request input.
  const today = await workspaceToday(actor.workspaceId);
  const { rows, total, filters } = await fetchEntityRows(entity, url, actor.workspaceId, db, today);

  const csvRows: unknown[][] = rows.map((row) => columns.map((col) => row[col]));

  const truncated = total > rows.length;
  if (truncated) {
    console.warn(
      `[nopm] export truncated: entity=${entity} workspace=${actor.workspaceId} returned=${rows.length} total=${total}`,
    );
    const noteRow = columns.map(() => "");
    noteRow[0] = `# TRUNCATED: showing ${rows.length} of ${total} matching rows (cap ${MAX_EXPORT_ROWS})`;
    csvRows.push(noteRow);
  }

  const csv = toCsv([...columns], csvRows);

  // L-36: exporting the audit log itself must appear in the audit log — one
  // fail-closed row for every export, regardless of entity.
  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "export.csv",
    targetType: "entity",
    targetId: null,
    before: null,
    after: { entity, row_count: rows.length, filters },
  });

  const filename = `nopm-${entity}-${today}.csv`;

  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
});
