import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, okList, created, validationError, safeJson } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { writeAudit } from "@/lib/audit/write";
import { createMilestoneSchema } from "@/app/api/milestones/_schema";

export const runtime = "nodejs";

// GET /api/projects/[id]/milestones — list milestones for a project
export const GET = route(async ({ actor, params, request }) => {
  requireScope(actor, "milestone:read");

  const projectId = params.id;
  const db = createAdminClient();

  // Verify project belongs to actor's workspace
  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (!project) throw new NotFoundError("Project not found");

  // Parse pagination params
  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const rawPage = parseInt(url.searchParams.get("page") ?? "1", 10);
  const limit = Math.min(Math.max(rawLimit, 1), 100);
  const page = Math.max(rawPage, 1);
  const offset = (page - 1) * limit;

  // Count query
  const { count } = await db
    .from("milestones")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("workspace_id", actor.workspaceId);

  // Data query
  const { data: milestones, error } = await db
    .from("milestones")
    .select("*")
    .eq("project_id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message);

  return okList(milestones ?? [], { total: count ?? 0, page, limit });
});

// POST /api/projects/[id]/milestones — create a milestone under a project
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "milestone:write");

  const projectId = params.id;
  const db = createAdminClient();

  // Verify project belongs to actor's workspace
  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (!project) throw new NotFoundError("Project not found");

  // Parse and validate body
  const body = await safeJson(request);
  const parsed = createMilestoneSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const fields = parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    }));
    return validationError("Invalid milestone data", fields);
  }

  const input = parsed.data;

  const { data: row, error } = await db
    .from("milestones")
    .insert({
      workspace_id: actor.workspaceId,
      project_id: projectId,
      name: input.name,
      target_date: input.target_date ?? null,
      status: input.status,
      completion_pct: input.completion_pct,
      owner_id: input.owner_id ?? null,
      sort_order: input.sort_order,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "milestone.create",
    targetType: "milestone",
    targetId: row.id,
    before: null,
    after: row,
  });

  return created(row);
});
