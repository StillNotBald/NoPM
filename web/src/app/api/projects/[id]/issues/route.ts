import { route } from "@/lib/api/handler";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { createIssueSchema } from "@/app/api/issues/_schema";

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

  const { data: items, error, count } = await db
    .from("issues")
    .select("*", { count: "exact" })
    .eq("workspace_id", actor.workspaceId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

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
  const parsed = createIssueSchema.safeParse(body);
  if (!parsed.success) {
    return validationError("Validation failed", parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })));
  }

  const input = parsed.data;

  const { data: row, error } = await db
    .from("issues")
    .insert({
      workspace_id: actor.workspaceId,
      project_id: projectId,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority,
      resolution: input.resolution ?? null,
      owner_id: input.owner_id ?? null,
      status: input.status,
      raised_at: input.raised_at ?? null,
      due_date: input.due_date ?? null,
    })
    .select()
    .single();

  if (error || !row) throw new Error(error?.message ?? "Insert failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "issue.create",
    targetType: "issue",
    targetId: row.id,
    before: null,
    after: row,
  });

  return created(row);
});
