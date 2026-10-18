import { route } from "@/lib/api/handler";
import { ok, safeJson } from "@/lib/api/response";
import { NotFoundError, RuleError, ScopeError } from "@/lib/api/errors";
import { isDemoActor } from "@/lib/auth/demo";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { BUCKET, MAX_FILE_SIZE, buildStoragePath } from "@/lib/documents/storage";

export const runtime = "nodejs";

/**
 * POST /api/documents/:id/file/sign — mint a short-lived signed upload URL.
 * The browser uploads bytes directly to this URL; our compute never holds them.
 * Body: { file_name, mime_type, file_size }
 * Returns: { data: { signedUrl, token, path } }
 */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "document:write");
  // The shared demo login is public: it never uploads files (A1-3).
  if (await isDemoActor(actor)) throw new ScopeError("Not available in the shared demo", "demo_readonly");

  const { id } = await Promise.resolve(params);
  const db = createAdminClient();

  const { data: doc, error: fetchError } = await db
    .from("documents")
    .select("id, workspace_id")
    .eq("id", id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!doc) throw new NotFoundError("Document not found");

  const body = await safeJson<{
    file_name: string;
    mime_type: string;
    file_size: number;
  }>(request);

  if (!body || !body.file_name || !body.mime_type || !body.file_size) {
    throw new RuleError("file_name, mime_type, and file_size are required");
  }

  if (!Number.isFinite(body.file_size) || body.file_size <= 0) {
    throw new RuleError("file_size must be a positive number of bytes");
  }
  if (body.file_size > MAX_FILE_SIZE) {
    throw new RuleError(
      `File exceeds the 25 MiB limit (received ${body.file_size} bytes)`,
    );
  }

  const path = buildStoragePath(actor.workspaceId, id, body.file_name);

  const admin = createAdminClient();
  const { data, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);

  if (signError || !data) {
    throw new Error(signError?.message ?? "Could not create signed upload URL");
  }

  return ok({ signedUrl: data.signedUrl, token: data.token, path });
});
