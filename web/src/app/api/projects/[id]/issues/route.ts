import { route } from "@/lib/api/handler";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { workspaceToday } from "@/lib/integrations/time-zone";
import { auditedInsert } from "@/lib/audit/audited-write";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";
import { RESOLUTION_NOTE_MESSAGE, needsResolutionNote } from "@/lib/work/resolution";
import { createIssueSchema } from "@/app/api/issues/_schema";
import { nextRefId } from "@/lib/ref-id";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";
import { assertBackupDiffers } from "@/lib/handover/backup";
import { parseListSelection } from "@/lib/api/views";
import { parseSort, orderOptions } from "@/lib/api/sort";
import { ISSUE_SORT_FIELDS, parseIssueFilters } from "@/app/api/issues/_query";

export { ISSUE_SORT_FIELDS };

export const runtime = "nodejs";

/** GET /api/projects/:id/issues — list issues for a project */
export const GET = route(async ({ actor, params, request }) => {
  requireScope(actor, "issue:read");

  const db = createAdminClient();
  const projectId = params.id;

  // Verify the project belongs to this workspace
  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (!project) throw new NotFoundError("Project not found");

  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const rawPage = parseInt(url.searchParams.get("page") ?? "1", 10);
  const limit = Math.min(100, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
  const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
  const offset = (page - 1) * limit;

  // Reject an unknown sort field/direction before touching the DB.
  const sort = parseSort(url.searchParams.get("sort"), ISSUE_SORT_FIELDS, {
    field: "created_at",
    ascending: false,
  });

  const filters = parseIssueFilters(url.searchParams);
  const selection = parseListSelection(url.searchParams, "issues"); // view=summary|full, fields= (R-129)

  let query = db
    .from("issues")
    .select(selection.select, { count: "exact" })
    .eq("workspace_id", actor.workspaceId)
    .eq("project_id", projectId);

  // Inline the parsed filters instead of the generic applyIssueFilters<Q>()
  // helper: chaining the generic against this route's concrete builder type
  // trips TS2589 (type instantiation excessively deep) — same workaround as
  // the audit/time-entries/export routes. parseIssueFilters stays the single
  // source of truth for param -> filter mapping.
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.severity) query = query.eq("severity", filters.severity);
  if (filters.priority) query = query.eq("priority", filters.priority);
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.external_ref) query = query.eq("external_ref", filters.external_ref);
  query = query.order(sort.field, orderOptions(sort));
  query = query.range(offset, offset + limit - 1);

  const { data: items, error, count } = await query;

  if (error) throw new Error(error.message);

  return okList(items ?? [], { total: count ?? 0, page, limit });
});

/** POST /api/projects/:id/issues — create an issue under a project */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "issue:write");

  const db = createAdminClient();
  const projectId = params.id;

  // Verify the project belongs to this workspace
  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (!project) throw new NotFoundError("Project not found");

  const body = await safeJson(request);
  const unknown = unknownFieldsResponse(body, createIssueSchema);
  if (unknown) return unknown;
  const parsed = createIssueSchema.safeParse(body);
  if (!parsed.success) {
    return validationError("Validation failed", parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })));
  }

  const input = parsed.data;

  // Q-WRK-19: an issue cannot be born resolved/closed without a resolution note.
  if ((input.status === "resolved" || input.status === "closed") && needsResolutionNote(input.resolution)) {
    return validationError(RESOLUTION_NOTE_MESSAGE, [{ field: "resolution", message: RESOLUTION_NOTE_MESSAGE }]);
  }

  // Cross-tenant guard: owner_id is a profile and must belong to THIS workspace.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "profiles", id: input.owner_id, field: "owner_id" },
    { table: "profiles", id: input.backup_owner_id, field: "backup_owner_id" },
  ]);
  assertBackupDiffers(input.owner_id, input.backup_owner_id, "backup_owner_id", "owner_id");

  const refId = await nextRefId(db, actor.workspaceId, "issues", "ISS");

  const row = await auditedInsert({
    table: "issues",
    actor,
    action: "issue.create",
    patch: {
      project_id: projectId,
      reference_id: refId,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority,
      resolution: input.resolution ?? null,
      owner_id: input.owner_id ?? null,
      backup_owner_id: input.backup_owner_id ?? null,
      status: input.status,
      raised_at: input.raised_at ?? (await workspaceToday(actor.workspaceId)), // NOT NULL date — default to today (workspace zone)
      due_date: input.due_date ?? null,
      // content-enrichment (0008): every field the schema accepts is saved.
      // severity is NOT NULL default medium: omit when not sent so the default applies.
      ...(input.severity !== undefined ? { severity: input.severity } : {}),
      issue_category: input.issue_category ?? null,
      impact: input.impact ?? null,
      resolution_eta: input.resolution_eta ?? null,
      resolved_at: input.resolved_at ?? null,
      // ── complement seam (0041, R-81) ─────────────────────────────────────────
      source: input.source ?? null,
      external_ref: input.external_ref ?? null,
      external_url: input.external_url ?? null,
    },
  });

  return created(row);
});
