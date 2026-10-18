import { route } from "@/lib/api/handler";
import { requestDeletion } from "@/lib/governance/request-deletion";
import { ok, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, RuleError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedUpdate } from "@/lib/audit/audited-write";
import { updateDocumentSchema } from "@/app/api/documents/_schema";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";
import { assertEvidenceLink, clearedEvidence } from "@/lib/documents/evidence";
import { approvalIsStale, assertMayApproveDocument, documentContentChanged } from "@/lib/documents/approval";

export const runtime = "nodejs";

/**
 * Columns GET /api/documents/:id returns: every column except `storage_path`, the internal
 * bucket path. A file is fetched through /file or /file/sign, which are scoped and audited.
 */
const DOCUMENT_GET_COLUMNS =
  "id,workspace_id,project_id,reference_id,folder,title,doc_type,status,version,summary,body,external_url,owner_id,created_by,created_at,updated_at,file_name,mime_type,file_size,change_request_id,evidence_type,evidence_result,tested_by_label,tested_at,evidence_note";

/** GET /api/documents/:id — fetch a single document. */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "document:read");

  const db = createAdminClient();

  const { data: row, error } = await db
    .from("documents")
    .select(DOCUMENT_GET_COLUMNS)
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

  // Q-GOV-14 / decision 25: only a manager or admin other than the author marks a document approved.
  const contentChanged = documentContentChanged(existing, input);
  const becomingApproved = input.status === "approved" && existing.status !== "approved";
  if (becomingApproved) {
    assertMayApproveDocument(actor, existing.created_by);
    if (contentChanged) {
      throw new RuleError("Save your edits first, then approve the document.", "approve_after_edit");
    }
  }

  // Cross-tenant guard: a changed project and owner (a profile) must both
  // belong to THIS workspace. null clears the link and is always allowed.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "projects", id: input.project_id, field: "project_id" },
    { table: "profiles", id: input.owner_id, field: "owner_id" },
  ]);

  // M4: the evidence link must stay inside this workspace and this project.
  await assertEvidenceLink(db, actor.workspaceId, existing, input);

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

  for (const k of ["change_request_id", "evidence_type", "evidence_result", "tested_by_label", "tested_at", "evidence_note"] as const) {
    if (input[k] !== undefined) updates[k] = input[k];
  }
  const effectiveCr = input.change_request_id !== undefined ? input.change_request_id : existing.change_request_id;
  if (!effectiveCr) {
    // Unlinked: the document carries no evidence fields.
    Object.assign(updates, clearedEvidence(existing));
  } else {
    const type = input.evidence_type !== undefined ? input.evidence_type : existing.evidence_type;
    if (type && input.evidence_type !== undefined && existing.evidence_type == null) {
      // Evidence newly recorded: stamp the tester and time unless the caller gave them.
      if (input.tested_by_label === undefined && !existing.tested_by_label) updates.tested_by_label = actor.label ?? null;
      if (input.tested_at === undefined && !existing.tested_at) updates.tested_at = new Date().toISOString();
    }
    if (!type) updates.evidence_result = null;
  }

  // Q-GOV-14: editing an approved document returns it to draft.
  if (approvalIsStale(existing.status, input.status, contentChanged)) {
    updates.status = "draft";
  }

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

  // The update and its audit row are one transaction (nopm_mutate_audited, migration 0103).
  const { after: updated } = await auditedUpdate({
    table: "documents",
    actor,
    action: "document.update",
    id: params.id,
    patch: updates,
    notFoundMessage: "Document not found",
  });

  return ok(updated);
});

/**
 * DELETE /api/documents/:id — does NOT delete the document. It raises a deletion request (scope
 * document:delete:request) with a required `reason` and returns 202. An approved document is on the manager tier
 * like any other (owner decision Q4; the audit trail tracks it). A second person approves it at POST /api/deletion-requests/:id/approve (audit gap G8).
 */
export const DELETE = route(async ({ actor, params, request }) =>
  requestDeletion({ actor, request, entity: "document", id: params.id }),
);
