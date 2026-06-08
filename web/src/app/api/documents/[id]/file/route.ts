import { NextResponse } from "next/server";
import { route } from "@/lib/api/handler";
import { noContent, ok, safeJson } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { BUCKET, validateStoragePath } from "@/lib/documents/storage";

export const runtime = "nodejs";

/** GET /api/documents/:id/file — redirect-download via a short-lived signed URL. */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "document:read");

  const { id } = await Promise.resolve(params);
  const db = createAdminClient();

  const { data: doc, error } = await db
    .from("documents")
    .select("id, workspace_id, storage_path, file_name, mime_type")
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!doc) throw new NotFoundError("Document not found");
  if (!doc.storage_path) throw new NotFoundError("No file attached to this document");

  const admin = createAdminClient();
  const { data: signed, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(doc.storage_path, 60);

  if (signError || !signed?.signedUrl) {
    throw new Error(signError?.message ?? "Could not generate signed URL");
  }

  return NextResponse.redirect(signed.signedUrl, 302);
});

/**
 * POST /api/documents/:id/file — record file metadata after the browser has
 * uploaded the bytes directly to the signed upload URL.
 * Body: { path, file_name, mime_type, file_size }
 */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "document:write");

  const { id } = await Promise.resolve(params);
  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("documents")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Document not found");

  const body = await safeJson<{
    path: string;
    file_name: string;
    mime_type: string;
    file_size: number;
  }>(request);

  if (!body || !body.path || !body.file_name || !body.mime_type || !body.file_size) {
    throw new RuleError("path, file_name, mime_type, and file_size are required");
  }

  // Verify the path truly belongs to this workspace + document.
  if (!validateStoragePath(body.path, actor.workspaceId, id)) {
    throw new RuleError("Storage path does not belong to this document");
  }

  // Confirm the object actually exists in the bucket (errors if missing).
  const admin = createAdminClient();
  const { error: checkError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(body.path, 60);

  if (checkError) {
    throw new RuleError("File not found in storage — upload may have failed");
  }

  const { data: updated, error: updateError } = await db
    .from("documents")
    .update({
      storage_path: body.path,
      file_name:    body.file_name,
      mime_type:    body.mime_type,
      file_size:    body.file_size,
      updated_at:   new Date().toISOString(),
    })
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .select()
    .single();

  if (updateError || !updated) throw new Error(updateError?.message ?? "Update failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action:     "document.file.attach",
    targetType: "document",
    targetId:   updated.id,
    before:     existing,
    after:      updated,
  });

  return ok(updated);
});

/** DELETE /api/documents/:id/file — remove the storage object and clear the columns. */
export const DELETE = route(async ({ actor, params }) => {
  requireScope(actor, "document:write");

  const { id } = await Promise.resolve(params);
  const db = createAdminClient();

  const { data: existing, error: fetchError } = await db
    .from("documents")
    .select("*")
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Document not found");
  if (!existing.storage_path) throw new NotFoundError("No file attached to this document");

  const admin = createAdminClient();
  const { error: removeError } = await admin.storage
    .from(BUCKET)
    .remove([existing.storage_path]);

  if (removeError) throw new Error(removeError.message);

  const { error: updateError } = await db
    .from("documents")
    .update({
      storage_path: null,
      file_name:    null,
      mime_type:    null,
      file_size:    null,
      updated_at:   new Date().toISOString(),
    })
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId);

  if (updateError) throw new Error(updateError.message);

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action:     "document.file.remove",
    targetType: "document",
    targetId:   existing.id,
    before:     existing,
    after:      null,
  });

  return noContent();
});
