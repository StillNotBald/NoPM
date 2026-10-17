import { route } from "@/lib/api/handler";
import { noContent, ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, PreconditionFailedError } from "@/lib/api/errors";
import { checkOptimisticConcurrency } from "@/lib/api/occ";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { updateIssueSchema } from "@/app/api/issues/_schema";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";

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

  // Cross-tenant guard: owner_id is a profile and must belong to THIS workspace.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "profiles", id: input.owner_id, field: "owner_id" },
  ]);

  // Optimistic concurrency (R-90) — opt-in via expected_updated_at. No-op when
  // the caller doesn't send it (today's last-write-wins, unchanged).
  checkOptimisticConcurrency(existing.updated_at, input.expected_updated_at);

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
  // content-enrichment (0008)
  if (input.severity !== undefined) updates.severity = input.severity;
  if (input.issue_category !== undefined) updates.issue_category = input.issue_category;
  if (input.impact !== undefined) updates.impact = input.impact;
  if (input.resolution_eta !== undefined) updates.resolution_eta = input.resolution_eta;
  if (input.resolved_at !== undefined) updates.resolved_at = input.resolved_at;
  // ── complement seam (0041, R-81) ────────────────────────────────────────────
  if (input.source !== undefined) updates.source = input.source;
  if (input.external_ref !== undefined) updates.external_ref = input.external_ref;
  if (input.external_url !== undefined) updates.external_url = input.external_url;

  let query = db
    .from("issues")
    .update(updates)
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);
  // Defense-in-depth: also scope the write itself to the row's pre-check
  // updated_at, closing the (narrow) race between the fetch above and this
  // write. On a lost race the row exists but the filter matches zero rows —
  // maybeSingle() returns null instead of PostgREST's "no rows" error.
  if (input.expected_updated_at !== undefined) {
    query = query.eq("updated_at", existing.updated_at);
  }
  const { data: updated, error: updateError } = await query.select().maybeSingle();

  if (updateError) throw new Error(updateError.message);
  if (!updated) {
    if (input.expected_updated_at !== undefined) {
      throw new PreconditionFailedError("Record changed since you loaded it");
    }
    throw new Error("Update failed");
  }

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
