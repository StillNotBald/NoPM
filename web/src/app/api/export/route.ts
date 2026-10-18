import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { workspaceToday } from "@/lib/integrations/time-zone";
import { toCsv } from "@/lib/export/csv";
import { parseSort, orderOptions } from "@/lib/api/sort";
import { TASK_SORT_FIELDS, parseTaskFilters } from "@/app/api/tasks/_query";
import { RISK_SORT_FIELDS, parseRiskFilters } from "@/app/api/risks/_query";
import { ISSUE_SORT_FIELDS, parseIssueFilters } from "@/app/api/issues/_query";
import { parseAuditFilters } from "@/app/api/audit/_query";
import { parseExportDay, dayAfter } from "./_audit-range";

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

const ENTITY_SCOPES = {
  tasks: "task:read",
  risks: "risk:read",
  issues: "issue:read",
  clashes: "clash:read",
  audit: "audit:read",
  programs: "program:read",
  projects: "project:read",
} as const;

type Entity = keyof typeof ENTITY_SCOPES;

const ENTITY_COLUMNS: Record<Entity, string[]> = {
  tasks: [
    "id", "workspace_id", "project_id", "milestone_id", "name", "description",
    "status", "status_type", "assignee_id", "priority", "start_date", "due_date",
    "completion_pct", "sort_order", "created_at", "updated_at",
  ],
  risks: [
    "id", "workspace_id", "project_id", "reference_id", "title", "description",
    "severity", "likelihood", "category", "mitigation", "owner_id", "status",
    "raised_at", "due_date", "created_at", "updated_at",
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
  return !!value && Object.prototype.hasOwnProperty.call(ENTITY_SCOPES, value);
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
  const { data, error, count } = await query
    .order(sort.field, orderOptions(sort))
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  return {
    rows: (data ?? []) as Record<string, unknown>[],
    total: count ?? (data ?? []).length,
    filters: { ...filters, sort: sp.get("sort") ?? undefined },
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

async function fetchRisksRows(sp: URLSearchParams, workspaceId: string, db: Db): Promise<FetchResult> {
  // project_id is OPTIONAL: given -> that project's risks (validated in-workspace);
  // omitted -> every risk in the actor's workspace (cross-project register).
  const projectId = sp.get("project_id");
  if (projectId) await assertProjectInWorkspace(db, projectId, workspaceId);

  const sort = parseSort(sp.get("sort"), RISK_SORT_FIELDS, { field: "created_at", ascending: false });
  const filters = parseRiskFilters(sp);
  const q = sp.get("q")?.trim() || undefined;
  let query = db.from("risks").select("*", { count: "exact" }).eq("workspace_id", workspaceId);
  if (projectId) query = query.eq("project_id", projectId);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.severity) query = query.eq("severity", filters.severity);
  if (q) query = query.ilike("title", ilikeTerm(q));
  const { data, error, count } = await query
    .order(sort.field, orderOptions(sort))
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  return {
    rows: (data ?? []) as Record<string, unknown>[],
    total: count ?? (data ?? []).length,
    filters: { project_id: projectId ?? undefined, ...filters, q, sort: sp.get("sort") ?? undefined },
  };
}

async function fetchIssuesRows(sp: URLSearchParams, workspaceId: string, db: Db): Promise<FetchResult> {
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
  const { data, error, count } = await query
    .order(sort.field, orderOptions(sort))
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  return {
    rows: (data ?? []) as Record<string, unknown>[],
    total: count ?? (data ?? []).length,
    filters: { project_id: projectId ?? undefined, ...filters, q, sort: sp.get("sort") ?? undefined },
  };
}

async function fetchClashesRows(_sp: URLSearchParams, workspaceId: string, db: Db): Promise<FetchResult> {
  // GET /clashes takes no filter/sort params — export mirrors that: fixed created_at desc.
  const { data, error, count } = await db
    .from("clashes")
    .select("*", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  return { rows: (data ?? []) as Record<string, unknown>[], total: count ?? (data ?? []).length, filters: {} };
}

async function fetchProjectsRows(sp: URLSearchParams, workspaceId: string, db: Db): Promise<FetchResult> {
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
  const { data, error, count } = await query
    .order(sort.field, orderOptions(sort))
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  return {
    rows: (data ?? []) as Record<string, unknown>[],
    total: count ?? (data ?? []).length,
    filters: { rag_status: ragStatus, phase, program_id: programId, q, sort: sp.get("sort") ?? undefined },
  };
}

async function fetchProgramsRows(_sp: URLSearchParams, workspaceId: string, db: Db): Promise<FetchResult> {
  // GET /programs takes no filter/sort params today — export mirrors that:
  // fixed name asc, same posture as fetchClashesRows above.
  const { data, error, count } = await db
    .from("programs")
    .select("*", { count: "exact" })
    .eq("workspace_id", workspaceId)
    .order("name", { ascending: true })
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  return { rows: (data ?? []) as Record<string, unknown>[], total: count ?? (data ?? []).length, filters: {} };
}

async function fetchAuditRows(sp: URLSearchParams, workspaceId: string, db: Db): Promise<FetchResult> {
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
  const from = parseExportDay(sp.get("from"));
  const to = parseExportDay(sp.get("to"));
  if (from !== undefined) query = query.gte("created_at", `${from}T00:00:00Z`);
  if (to !== undefined) query = query.lt("created_at", dayAfter(to));
  const { data, error, count } = await query
    .order("created_at", { ascending: filters.order === "asc" })
    .range(0, MAX_EXPORT_ROWS - 1);
  if (error) throw new Error(`Export query failed: ${error.message}`);
  return {
    rows: (data ?? []) as Record<string, unknown>[],
    total: count ?? (data ?? []).length,
    filters: { ...filters, from, to },
  };
}

async function fetchEntityRows(
  entity: Entity,
  url: URL,
  workspaceId: string,
  db: Db,
  today: string,
): Promise<FetchResult> {
  const sp = url.searchParams;
  switch (entity) {
    case "tasks":
      return fetchTasksRows(sp, workspaceId, db, today);
    case "risks":
      return fetchRisksRows(sp, workspaceId, db);
    case "issues":
      return fetchIssuesRows(sp, workspaceId, db);
    case "clashes":
      return fetchClashesRows(sp, workspaceId, db);
    case "audit":
      return fetchAuditRows(sp, workspaceId, db);
    case "programs":
      return fetchProgramsRows(sp, workspaceId, db);
    case "projects":
      return fetchProjectsRows(sp, workspaceId, db);
  }
}

export const GET = route(async ({ actor, request }) => {
  const url = new URL(request.url);
  const entityParam = url.searchParams.get("entity");

  if (!isEntity(entityParam)) {
    throw new RuleError(`entity must be one of: ${Object.keys(ENTITY_SCOPES).join(", ")}`);
  }
  const entity = entityParam;

  requireScope(actor, ENTITY_SCOPES[entity]);

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

  const csv = toCsv(columns, csvRows);

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
