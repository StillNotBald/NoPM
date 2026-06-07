import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, okList, created, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
import { TaskCreateSchema } from "@/app/api/tasks/_schema";

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

  const { data: items, error, count } = await db
    .from("tasks")
    .select("*", { count: "exact" })
    .eq("workspace_id", actor.workspaceId)
    .eq("project_id", projectId)
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

  // Verify project belongs to workspace
  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (!project) throw new NotFoundError("Project not found");

  const body = await safeJson(request);
  const parsed = TaskCreateSchema.safeParse(body);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return validationError("Validation failed", fields);
  }

  const input = parsed.data;

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

  const { data: row, error } = await db
    .from("tasks")
    .insert({
      workspace_id: actor.workspaceId,
      project_id: projectId,
      milestone_id: input.milestone_id ?? null,
      name: input.name,
      description: input.description ?? null,
      status:
        input.status ??
        input.status_type.charAt(0).toUpperCase() + input.status_type.slice(1),
      status_type: input.status_type,
      assignee_id: input.assignee_id ?? null,
      priority: input.priority,
      start_date: input.start_date ?? null,
      due_date: input.due_date ?? null,
      completion_pct: input.completion_pct,
      sort_order: input.sort_order ?? 0,
    })
    .select()
    .single();

  if (error || !row) throw new Error(error?.message ?? "Insert failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "task.create",
    targetType: "task",
    targetId: row.id,
    before: null,
    after: row,
  });

  return created(row);
});
