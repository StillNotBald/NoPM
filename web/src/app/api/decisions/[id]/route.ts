import { route } from "@/lib/api/handler";
import { noContent, ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { updateDecisionSchema } from "@/app/api/decisions/_schema";

export const runtime = "nodejs";

/** GET /api/decisions/:id — fetch a single decision */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "decision:read");

  const db = createAdminClient();

  const { data: row, error } = await db
    .from("decisions")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!row) throw new NotFoundError("Decision not found");

  return ok(row);
});

/** PATCH /api/decisions/:id — update a decision */
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "decision:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("decisions")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Decision not found");

  const body = await safeJson(request);
  const parsed = updateDecisionSchema.safeParse(body);
  if (!parsed.success) {
    return validationError("Validation failed", parsed.error.issues.map((e) => ({
      field: e.path.join("."),
      message: e.message,
    })));
  }

  const input = parsed.data;

  const updates: Record<string, unknown> = {};
  if (input.title !== undefined) updates.title = input.title;
  if (input.context !== undefined) updates.context = input.context;
  if (input.options !== undefined) updates.options = input.options;
  if (input.decision !== undefined) updates.decision = input.decision;
  if (input.rationale !== undefined) updates.rationale = input.rationale;
  if (input.status !== undefined) updates.status = input.status;
  if (input.decided_at !== undefined) updates.decided_at = input.decided_at;
  if (input.supersedes !== undefined) updates.supersedes = input.supersedes;
  // ── complement seam (0041, R-81) ────────────────────────────────────────────
  if (input.source !== undefined) updates.source = input.source;
  if (input.external_ref !== undefined) updates.external_ref = input.external_ref;
  if (input.external_url !== undefined) updates.external_url = input.external_url;

  const { data: updated, error: updateError } = await db
    .from("decisions")
    .update(updates)
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError || !updated) throw new Error(updateError?.message ?? "Update failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "decision.update",
    targetType: "decision",
    targetId: updated.id,
    before: existing,
    after: updated,
  });

  return ok(updated);
});

/** DELETE /api/decisions/:id — delete a decision */
export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "decision:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("decisions")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Decision not found");

  const { error: deleteError } = await db
    .from("decisions")
    .delete()
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (deleteError) throw new Error(deleteError.message);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action: "decision.delete",
    targetType: "decision",
    targetId: existing.id,
    before: existing,
    after: null,
  });

  return noContent();
});
