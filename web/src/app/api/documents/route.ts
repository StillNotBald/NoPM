import { route } from "@/lib/api/handler";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedInsert } from "@/lib/audit/audited-write";
import { asInsertResult } from "@/lib/audit/insert-result";
import { insertWithReference } from "@/lib/governance/next-ref";
import { createDocumentSchema } from "@/app/api/documents/_schema";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";
import { assertMayApproveDocument } from "@/lib/documents/approval";
import { assertEvidenceLink } from "@/lib/documents/evidence";

export const runtime = "nodejs";

/** GET /api/documents — list documents, workspace-scoped. */
export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "document:read");

  const db = createAdminClient();
  const url = new URL(request.url);

  const rawLimit  = parseInt(url.searchParams.get("limit")  ?? "20", 10);
  const rawPage   = parseInt(url.searchParams.get("page")   ?? "1",  10);
  const limit     = Math.min(100, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
  const page      = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
  const offset    = (page - 1) * limit;

  const projectId = url.searchParams.get("project_id");
  const folder    = url.searchParams.get("folder");
  const status    = url.searchParams.get("status");
  const docType   = url.searchParams.get("doc_type");
  const changeRequestId = url.searchParams.get("change_request_id");

  let query = db
    .from("documents")
    .select("*", { count: "exact" })
    .eq("workspace_id", actor.workspaceId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (projectId) query = query.eq("project_id", projectId);
  if (folder)    query = query.eq("folder", folder);
  if (status)    query = query.eq("status", status);
  if (docType)   query = query.eq("doc_type", docType);
  if (changeRequestId) query = query.eq("change_request_id", changeRequestId);

  const { data: items, error, count } = await query;
  if (error) throw new Error(error.message);

  return okList(items ?? [], { total: count ?? 0, page, limit });
});

/** POST /api/documents — create a document. */
export const POST = route(async ({ actor, request }) => {
  requireScope(actor, "document:write");

  const db   = createAdminClient();
  const body = await safeJson(request);
  const parsed = createDocumentSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }

  const input = parsed.data;

  // Q-GOV-14: a new document is by definition authored by its creator, so it can never be
  // created already approved (an approver other than the author must approve it later).
  if (input.status === "approved") assertMayApproveDocument(actor, actor.principalId ?? actor.id);

  // Cross-tenant guard: the project and the owner (a profile) must both
  // belong to THIS workspace.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "projects", id: input.project_id, field: "project_id" },
    { table: "profiles", id: input.owner_id, field: "owner_id" },
  ]);

  // M4: a linked change request must be in this workspace and in the document's project.
  await assertEvidenceLink(db, actor.workspaceId, null, input);
  const linked = !!input.change_request_id;
  const evidenceType = linked ? (input.evidence_type ?? null) : null;

  // The DOC-NNN reference comes from a per-workspace counter that never goes
  // backwards (a deleted newest record does not free its number). The row and its
  // audit row are one transaction (nopm_mutate_audited, migration 0103).
  const { data: inserted, error } = await insertWithReference(db, actor.workspaceId, "document", (refId) => asInsertResult(auditedInsert({
    table: "documents",
    actor,
    action: "document.create",
    patch: {
      project_id:   input.project_id  ?? null,
      reference_id: refId,
      folder:       input.folder       ?? "General",
      title:        input.title,
      doc_type:     input.doc_type,
      status:       input.status       ?? "draft",
      summary:      input.summary      ?? null,
      body:         input.body         ?? null,
      external_url: input.external_url ?? null,
      owner_id:     input.owner_id     ?? null,
      change_request_id: input.change_request_id ?? null,
      evidence_type:     evidenceType,
      evidence_result:   linked && evidenceType ? (input.evidence_result ?? null) : null,
      tested_by_label:   linked && evidenceType ? (input.tested_by_label ?? actor.label ?? null) : null,
      tested_at:         linked && evidenceType ? (input.tested_at ?? new Date().toISOString()) : null,
      evidence_note:     linked ? (input.evidence_note ?? null) : null,
      created_by:   actor.type === "user" ? actor.id : null,
    },
  })));
  if (error || !inserted) throw new Error(error?.message ?? "Insert failed");
  const row = inserted;

  return created(row);
});
