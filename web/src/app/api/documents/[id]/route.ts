import { route } from "@/lib/api/handler";
import { noContent, ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { updateDocumentSchema } from "@/app/api/documents/_schema";

export const runtime = "nodejs";

/** GET /api/documents/:id — fetch a single document. */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "document:read");

  const db = createAdminClient();

  const { data: row, error } = await db
    .from("documents")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!row) throw new NotFoundError("Document not found");

  return ok(row);
});

/** PATCH /api/documents/:id — partial update; bumps version when body changes. */
export const PATCH = route(async ({ actor, params, request }) => {
  requireScope(actor, "document:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("documents")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Document not found");

  const body = await safeJson(request);
  const parsed = updateDocumentSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const input = parsed.data;

  // If project_id is being changed, verify it belongs to this workspace.
  if (input.project_id !== undefined && input.project_id !== null) {
    const { data: proj } = await db
      .from("projects")
      .select("id")
      .eq("id", input.project_id)
      .eq("workspace_id", actor.workspaceId)
      .maybeSingle();
    if (!proj) {
      return validationError("Validation failed", [
        { field: "project_id", message: "Project not found in this workspace" },
      ]);
    }
  }

  // Build only the fields provided in the patch.
  const updates: Record<string, unknown> = {};
  if (input.project_id   !== undefined) updates.project_id   = input.project_id;
  if (input.folder       !== undefined) updates.folder       = input.folder;
  if (input.title        !== undefined) updates.title        = input.title;
  if (input.doc_type     !== undefined) updates.doc_type     = input.doc_type;
  if (input.status       !== undefined) updates.status       = input.status;
  if (input.summary      !== undefined) updates.summary      = input.summary;
  if (input.external_url !== undefined) updates.external_url = input.external_url;
  if (input.owner_id     !== undefined) updates.owner_id     = input.owner_id;

  // Bump version when body content changes.
  if (input.body !== undefined) {
    updates.body = input.body;
    if (input.body !== existing.body) {
      updates.version = (existing.version ?? 1) + 1;
    }
  }

  if (Object.keys(updates).length === 0) {
    return ok(existing);
  }

  const { data: updated, error: updateError } = await db
    .from("documents")
    .update(updates)
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError || !updated) throw new Error(updateError?.message ?? "Update failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action:     "document.update",
    targetType: "document",
    targetId:   updated.id,
    before:     existing,
    after:      updated,
  });

  return ok(updated);
});

/** DELETE /api/documents/:id — audited hard delete. */
export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "document:write");

  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("documents")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Document not found");

  const { error: deleteError } = await db
    .from("documents")
    .delete()
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId);

  if (deleteError) throw new Error(deleteError.message);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action:     "document.delete",
    targetType: "document",
    targetId:   existing.id,
    before:     existing,
    after:      null,
  });

  return noContent();
});
