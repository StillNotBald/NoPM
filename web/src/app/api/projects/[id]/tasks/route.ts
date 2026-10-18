import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { okList, created, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
import { auditedInsert } from "@/lib/audit/audited-write";
import { parseListSelection } from "@/lib/api/views";
import { TaskCreateSchema } from "@/app/api/tasks/_schema";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";
import { assertProjectUnlocked } from "@/lib/governance/lock";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";
import { assertTaskBackupDiffers } from "@/lib/handover/backup";
import { hashRequestBody, readIdempotencyKey, withIdempotency } from "@/lib/api/idempotency";

export const runtime = "nodejs";

/** GET /api/projects/[id]/tasks — list tasks for a project */
export const GET = route(async ({ actor, params, request }) => {
  requireScope(actor, "task:read");

  const projectId = params.id;
  const db = createAdminClient();

  // Verify the project exists and belongs to this workspace
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

  // Complement-seam filters (R-81): exact match on the source system / its
  // reference id, so an agent can find "the NoPM task that mirrors PROJ-123"
  // within a project. Same params as GET /api/tasks; the CLI's
  // `nopm tasks ls --external-ref` targets this route.
  const source = url.searchParams.get("source");
  const externalRef = url.searchParams.get("external_ref");
  const selection = parseListSelection(url.searchParams, "tasks"); // view=summary|full, fields= (R-129)

  let query = db
    .from("tasks")
    .select(selection.select, { count: "exact" })
    .eq("workspace_id", actor.workspaceId)
    .eq("project_id", projectId);
  if (source) query = query.eq("source", source);
  if (externalRef) query = query.eq("external_ref", externalRef);

  const { data: items, error, count } = await query
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message);

  return okList(items ?? [], { total: count ?? 0, page, limit });
});

/** POST /api/projects/[id]/tasks — create a task in a project */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "task:write");

  const projectId = params.id;
  const db = createAdminClient();

  // Verify project belongs to workspace, and is not locked — task creation
  // reshapes the schedule, so it is always blocked while the baseline is frozen.
  await assertProjectUnlocked(db, projectId, actor.workspaceId, () =>
    writeAudit({
      workspaceId: actor.workspaceId,
      actor,
      action: "task.create.blocked",
      targetType: "task",
      targetId: null,
      before: null,
      after: { reason: "project_locked", project_id: projectId },
    }),
  );

  const body = await safeJson(request);
  const unknown = unknownFieldsResponse(body, TaskCreateSchema);
  if (unknown) return unknown;
  const parsed = TaskCreateSchema.safeParse(body);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return validationError("Validation failed", fields);
  }

  const input = parsed.data;

  // Cross-tenant guard: the assignee is a resource_member and the blocker a
  // task, both of which must live in THIS workspace (the FKs accept any row).
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "resource_members", id: input.assignee_id, field: "assignee_id" },
    { table: "resource_members", id: input.backup_assignee_id, field: "backup_assignee_id" },
    { table: "tasks", id: input.blocked_by, field: "blocked_by" },
  ]);

  await assertTaskBackupDiffers(db, actor.workspaceId, input.assignee_id, input.backup_assignee_id);

  // Validate milestone belongs to same workspace + project if provided
  if (input.milestone_id) {
    const { data: milestone } = await db
      .from("milestones")
      .select("id")
      .eq("id", input.milestone_id)
      .eq("workspace_id", actor.workspaceId)
      .eq("project_id", projectId)
      .maybeSingle();
    if (!milestone) throw new NotFoundError("Milestone not found in this project");
  }

  // D-WRK-12: a retry with the same Idempotency-Key returns the first task.
  const idem = await withIdempotency(
    {
      workspaceId: actor.workspaceId,
      actorId: actor.id,
      key: readIdempotencyKey(request),
      route: `POST /api/projects/${projectId}/tasks`,
      bodyHash: hashRequestBody(parsed.data),
    },
    async () => {
  const row = await auditedInsert({
    table: "tasks",
    actor,
    action: "task.create",
    patch: {
      project_id: projectId,
      milestone_id: input.milestone_id ?? null,
      name: input.name,
      description: input.description ?? null,
      status:
        input.status ??
        input.status_type.charAt(0).toUpperCase() + input.status_type.slice(1),
      status_type: input.status_type,
      assignee_id: input.assignee_id ?? null,
      backup_assignee_id: input.backup_assignee_id ?? null,
      priority: input.priority,
      start_date: input.start_date ?? null,
      due_date: input.due_date ?? null,
      completion_pct: input.completion_pct,
      sort_order: input.sort_order ?? 0,
      // ── content-enrichment (0008) ────────────────────────────────────────────
      acceptance_criteria: input.acceptance_criteria ?? null,
      estimate_hours: input.estimate_hours ?? null,
      story_points: input.story_points ?? null,
      blocker_reason: input.blocker_reason ?? null, // R-166 (0111)
      eta: input.eta ?? null, // R-166 (0111): a date, may be in the past
      labels: input.labels ?? [], // NOT NULL default '{}' — never insert null
      checklist: input.checklist ?? [], // NOT NULL default '[]' — never insert null
      // ── complement seam (0041, R-81) ─────────────────────────────────────────
      source: input.source ?? null,
      external_ref: input.external_ref ?? null,
      external_url: input.external_url ?? null,
    },
  });

  return row;
    },
  );

  return created(idem.result);
});
