import { NextResponse } from "next/server";
import { route } from "@/lib/api/handler";
import { noContent, ok, safeJson } from "@/lib/api/response";
import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { isDemoActor } from "@/lib/auth/demo";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { BUCKET, INLINE_MIME_TYPES, MAX_FILE_SIZE, buildStoragePath, matchesMagicBytes, normalizeMimeType, validateStoragePath } from "@/lib/documents/storage";

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
  // Only inline-safe types are served for rendering; everything else is a download.
  const inline = INLINE_MIME_TYPES.has(normalizeMimeType(doc.mime_type ?? ""));
  const { data: signed, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(doc.storage_path, 60, inline ? undefined : { download: doc.file_name ?? true });

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
  // The shared demo login is public: it never uploads files (A1-3).
  if (await isDemoActor(actor)) throw new ScopeError("Not available in the shared demo", "demo_readonly");

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
  // Exact shape (<workspace>/<document>/<clean name>), and it must be the path the
  // sign step minted for this file name — not merely something under the prefix.
  if (
    !validateStoragePath(body.path, actor.workspaceId, id) ||
    body.path !== buildStoragePath(actor.workspaceId, id, body.file_name)
  ) {
    throw new RuleError("Storage path does not belong to this document");
  }
  if (!Number.isFinite(body.file_size) || body.file_size <= 0 || body.file_size > MAX_FILE_SIZE) {
    throw new RuleError("file_size must be between 1 byte and 25 MiB");
  }

  // Confirm the object actually exists in the bucket (errors if missing).
  const admin = createAdminClient();
  const { data: signedCheck, error: checkError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(body.path, 60);

  if (checkError || !signedCheck?.signedUrl) {
    throw new RuleError("File not found in storage — upload may have failed");
  }

  // Never trust the declared type: browser-executable types are coerced to
  // octet-stream, and inline-rendered types (PDF/images) must match the bytes.
  const mimeType = normalizeMimeType(body.mime_type);
  if (INLINE_MIME_TYPES.has(mimeType)) {
    const head = await readLeadingBytes(signedCheck.signedUrl);
    if (!matchesMagicBytes(mimeType, head)) {
      throw new RuleError(`File content does not match the declared mime_type (${mimeType})`);
    }
  }

  const { data: updated, error: updateError } = await db
    .from("documents")
    .update({
      storage_path: body.path,
      file_name:    body.file_name,
      mime_type:    mimeType,
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

  // Last: the record and its audit row are already committed, so a failure here
  // can leave an unreferenced object but never a record pointing at a missing
  // one (A3-6). The object is retried by hand; the audit row carries its path.
  const admin = createAdminClient();
  const { error: removeError } = await admin.storage
    .from(BUCKET)
    .remove([existing.storage_path]);
  if (removeError) {
    console.error("[documents] file record cleared but the storage object could not be removed", {
      documentId: existing.id,
      path: existing.storage_path,
      message: removeError.message,
    });
  }

  return noContent();
});

/** Fetch the first ~1 KiB of a storage object (Range request; falls back to the first chunk). */
async function readLeadingBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { Range: "bytes=0-1023" } });
  if (!res.ok || !res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  await reader.cancel().catch(() => undefined);
  return value ? value.subarray(0, 1024) : new Uint8Array(0);
}
