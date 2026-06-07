import { route } from "@/lib/api/handler";
import { noContent, ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { updateIssueSchema } from "@/app/api/issues/_schema";

export const runtime = "nodejs";

/** GET /api/issues/:id — fetch a single issue */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "issue:read");

  const db = createAdminClient();

  const { data: row, error } = await db
    .from("issues")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!row) throw new NotFoundError("Issue not found");

  return ok(row);
});

/** PATCH /api/issues/:id — update an issue */
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "issue:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("issues")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Issue not found");

  const body = await safeJson(request);
  const parsed = updateIssueSchema.safeParse(body);
  if (!parsed.success) {
    return validationError("Validation failed", parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })));
  }

  const input = parsed.data;

  // Build only the fields provided in the patch
  const updates: Record<string, unknown> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
  if (input.priority !== undefined) updates.priority = input.priority;
  if (input.resolution !== undefined) updates.resolution = input.resolution;
  if (input.owner_id !== undefined) updates.owner_id = input.owner_id;
  if (input.status !== undefined) updates.status = input.status;
  if (input.raised_at !== undefined) updates.raised_at = input.raised_at;
  if (input.due_date !== undefined) updates.due_date = input.due_date;

  const { data: updated, error: updateError } = await db
    .from("issues")
    .update(updates)
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError || !updated) throw new Error(updateError?.message ?? "Update failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "issue.update",
    targetType: "issue",
    targetId: updated.id,
    before: existing,
    after: updated,
  });

  return ok(updated);
});

/** DELETE /api/issues/:id — delete an issue */
export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "issue:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("issues")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Issue not found");

  const { error: deleteError } = await db
    .from("issues")
    .delete()
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (deleteError) throw new Error(deleteError.message);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "issue.delete",
    targetType: "issue",
    targetId: existing.id,
    before: existing,
    after: null,
  });

  return noContent();
});
