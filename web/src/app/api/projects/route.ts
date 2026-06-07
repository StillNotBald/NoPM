import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { createProjectSchema } from "./_schema";

export const runtime = "nodejs";

// GET /api/projects — list projects in the actor's workspace (project:read)
export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "project:read");

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10)));
  const offset = (page - 1) * limit;

  const db = createAdminClient();

  const { count, error: countError } = await db
    .from("projects")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", actor.workspaceId);

  if (countError) throw countError;

  const { data, error } = await db
    .from("projects")
    .select("*")
    .eq("workspace_id", actor.workspaceId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  return okList(data ?? [], { total: count ?? 0, page, limit });
});

// POST /api/projects — create a project (project:write)
export const POST = route(async ({ actor, request }) => {
  requireScope(actor, "project:write");

  const body = await safeJson(request);
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid project data",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }

  const db = createAdminClient();

  const now = new Date().toISOString();
  const { data: row, error } = await db
    .from("projects")
    .insert({
      ...parsed.data,
      workspace_id: actor.workspaceId,
      updated_at: now,
    })
    .select()
    .single();

  if (error) throw error;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "project.create",
    targetType: "project",
    targetId: row.id,
    before: null,
    after: row,
  });

  return created(row);
});
