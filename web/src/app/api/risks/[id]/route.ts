import { route } from "@/lib/api/handler";
import { noContent, ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { updateRiskSchema } from "@/app/api/risks/_schema";

export const runtime = "nodejs";

/** GET /api/risks/:id — fetch a single risk */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "risk:read");

  const db = createAdminClient();

  const { data: row, error } = await db
    .from("risks")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!row) throw new NotFoundError("Risk not found");

  return ok(row);
});

/** PATCH /api/risks/:id — update a risk */
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "risk:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("risks")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Risk not found");

  const body = await safeJson(request);
  const parsed = updateRiskSchema.safeParse(body);
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
  if (input.severity !== undefined) updates.severity = input.severity;
  if (input.likelihood !== undefined) updates.likelihood = input.likelihood;
  if (input.category !== undefined) updates.category = input.category;
  if (input.mitigation !== undefined) updates.mitigation = input.mitigation;
  if (input.owner_id !== undefined) updates.owner_id = input.owner_id;
  if (input.status !== undefined) updates.status = input.status;
  if (input.raised_at !== undefined) updates.raised_at = input.raised_at;
  if (input.due_date !== undefined) updates.due_date = input.due_date;

  const { data: updated, error: updateError } = await db
    .from("risks")
    .update(updates)
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError || !updated) throw new Error(updateError?.message ?? "Update failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "risk.update",
    targetType: "risk",
    targetId: updated.id,
    before: existing,
    after: updated,
  });

  return ok(updated);
});

/** DELETE /api/risks/:id — delete a risk */
export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "risk:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("risks")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Risk not found");

  const { error: deleteError } = await db
    .from("risks")
    .delete()
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (deleteError) throw new Error(deleteError.message);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "risk.delete",
    targetType: "risk",
    targetId: existing.id,
    before: existing,
    after: null,
  });

  return noContent();
});
