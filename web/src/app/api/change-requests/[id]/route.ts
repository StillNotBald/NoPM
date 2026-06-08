import { route } from "@/lib/api/handler";
import { noContent, ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { updateChangeRequestSchema } from "@/app/api/change-requests/_schema";

export const runtime = "nodejs";

/** GET /api/change-requests/:id — fetch a single change request */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "change:read");

  const db = createAdminClient();

  const { data: row, error } = await db
    .from("change_requests")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!row) throw new NotFoundError("Change request not found");

  return ok(row);
});

/** PATCH /api/change-requests/:id — update a change request */
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "change:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("change_requests")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Change request not found");

  const body = await safeJson(request);
  const parsed = updateChangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return validationError("Validation failed", parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })));
  }

  const input = parsed.data;

  const updates: Record<string, unknown> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.description !== undefined) updates.description = input.description;
  if (input.category !== undefined) updates.category = input.category;
  if (input.priority !== undefined) updates.priority = input.priority;
  if (input.status !== undefined) updates.status = input.status;
  if (input.impact_summary !== undefined) updates.impact_summary = input.impact_summary;
  if (input.impact_schedule_days !== undefined) updates.impact_schedule_days = input.impact_schedule_days;
  if (input.impact_cost !== undefined) updates.impact_cost = input.impact_cost;
  if (input.target_date !== undefined) updates.target_date = input.target_date;
  if (input.raised_at !== undefined) updates.raised_at = input.raised_at;

  const { data: updated, error: updateError } = await db
    .from("change_requests")
    .update(updates)
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError || !updated) throw new Error(updateError?.message ?? "Update failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "change_request.update",
    targetType: "change_request",
    targetId: updated.id,
    before: existing,
    after: updated,
  });

  return ok(updated);
});

/** DELETE /api/change-requests/:id — delete a change request */
export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "change:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("change_requests")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Change request not found");

  const { error: deleteError } = await db
    .from("change_requests")
    .delete()
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (deleteError) throw new Error(deleteError.message);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "change_request.delete",
    targetType: "change_request",
    targetId: existing.id,
    before: existing,
    after: null,
  });

  return noContent();
});
