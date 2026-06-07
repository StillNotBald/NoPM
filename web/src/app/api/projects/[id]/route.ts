import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { ok, noContent, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { updateProjectSchema } from "../_schema";

export const runtime = "nodejs";

// GET /api/projects/[id] — fetch a single project (project:read)
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "project:read");

  const db = createAdminClient();
  const { data, error } = await db
    .from("projects")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new NotFoundError("Project not found");

  return ok(data);
});

// PATCH /api/projects/[id] — partial update (project:write)
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "project:write");

  const db = createAdminClient();

  // Fetch the existing row first for before snapshot + workspace guard
  const { data: before, error: fetchError } = await db
    .from("projects")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!before) throw new NotFoundError("Project not found");

  const body = await safeJson(request);
  const parsed = updateProjectSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Invalid project data",
      parsed.error.issues.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      })),
    );
  }

  const now = new Date().toISOString();
  const { data: after, error: updateError } = await db
    .from("projects")
    .update({
      ...parsed.data,
      workspace_id: actor.workspaceId, // never let caller overwrite
      updated_at: now,
    })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError) throw updateError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "project.update",
    targetType: "project",
    targetId: params.id,
    before,
    after,
  });

  return ok(after);
});

// DELETE /api/projects/[id] — hard delete (project:write)
export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "project:write");

  const db = createAdminClient();

  // Fetch before snapshot + workspace guard
  const { data: before, error: fetchError } = await db
    .from("projects")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw fetchError;
  if (!before) throw new NotFoundError("Project not found");

  const { error: deleteError } = await db
    .from("projects")
    .delete()
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (deleteError) throw deleteError;

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "project.delete",
    targetType: "project",
    targetId: params.id,
    before,
    after: null,
  });

  return noContent();
});
