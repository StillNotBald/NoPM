import { route } from "@/lib/api/handler";
import { created, ok, okList, safeJson, validationError } from "@/lib/api/response";
import { NotFoundError, PreconditionFailedError, RuleError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { auditedInsert, auditedUpdate } from "@/lib/audit/audited-write";
import { asInsertResult } from "@/lib/audit/insert-result";
import { insertWithReference } from "@/lib/governance/next-ref";
import { assertEvidenceLink } from "@/lib/documents/evidence";
import { attachEvidenceSchema } from "./_schema";

export const runtime = "nodejs";

const EVIDENCE_COLUMNS =
  "id, reference_id, title, doc_type, status, version, project_id, change_request_id, evidence_type, evidence_result, tested_by_label, tested_at, evidence_note, external_url, file_name, mime_type, created_at, updated_at";

/** A rejected or deferred request is not being tested, so it takes no new evidence. */
const EVIDENCE_STATUSES = ["raised", "under_review", "emergency", "approved", "implemented"];

async function loadChangeRequest(db: ReturnType<typeof createAdminClient>, workspaceId: string, id: string) {
  const { data, error } = await db
    .from("change_requests")
    .select("id, project_id, status")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new NotFoundError("Change request not found");
  return data as { id: string; project_id: string | null; status: string };
}

/**
 * GET /api/change-requests/:id/evidence — documents attached to this change
 * request as test / UAT / deploy evidence, newest test first. Workspace-scoped.
 * Read-only; POST on this same path attaches evidence (audited as a document write).
 */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "document:read");
  const db = createAdminClient();
  await loadChangeRequest(db, actor.workspaceId, params.id);

  const { data, error, count } = await db
    .from("documents")
    .select(EVIDENCE_COLUMNS, { count: "exact" })
    .eq("workspace_id", actor.workspaceId)
    .eq("change_request_id", params.id)
    .order("tested_at", { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) throw new Error(error.message);

  const items = data ?? [];
  return okList(items, { total: count ?? items.length, page: 1, limit: 200 });
});

/**
 * POST /api/change-requests/:id/evidence (R-171) — attach evidence to a change request.
 * Body: `document_id` (link an existing document) OR `title` (+ optional doc_type, folder, summary, body,
 * external_url: create a new document under the request's project), plus `evidence_type` (required),
 * `evidence_result`, `tested_by`, `tested_at`, `evidence_note`.
 *
 * Tester: always the acting person's display name. Only an admin or manager session may set `tested_by` to someone
 * else; from a token or any other role the text is kept in `evidence_note` as an unverified claim.
 * Linking is compare-and-set: if the document changed between the read and the write, a link to another request
 * is 422 evidence_linked_elsewhere and any other change is a 412.
 *
 * Same write path as POST/PATCH /api/documents: scope document:write, workspace-filtered, the document
 * reference counter, assertEvidenceLink, and exactly one audit row (`document.create` for a new document,
 * `document.update` for a link), written in the same transaction as the row (nopm_mutate_audited).
 * 201 new document, 200 linked document.
 *   404 change request or document not in this workspace
 *   422 evidence_not_accepted    - the request is rejected or deferred
 *   422 evidence_linked_elsewhere - the document is already evidence for a different change request
 *   422 evidence_link_invalid    - the document belongs to a different project than the request
 */
export const POST = route(async ({ actor, params, request }) => {
  requireScope(actor, "document:write");

  const body = await safeJson(request);
  const parsed = attachEvidenceSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(
      "Validation failed",
      parsed.error.issues.map((e) => ({ field: e.path.join("."), message: e.message })),
    );
  }
  const input = parsed.data;

  const db = createAdminClient();
  const cr = await loadChangeRequest(db, actor.workspaceId, params.id);
  if (!EVIDENCE_STATUSES.includes(cr.status)) {
    throw new RuleError(
      `A ${cr.status} change request does not take evidence. Evidence can be attached while it is raised, under review, emergency, approved or implemented.`,
      "evidence_not_accepted",
    );
  }

  // W2-13: the tester is the acting person. Only an admin or manager SESSION may name someone else; from a token
  // or any other role the caller's text is kept in the note as a claim and the tester stays the actor.
  const mayNameTester = actor.type === "user" && (actor.role === "admin" || actor.role === "manager");
  const claimed = input.tested_by?.trim() || null;
  let note = input.evidence_note ?? null;
  let testedBy = actor.label ?? null;
  if (claimed && mayNameTester) testedBy = claimed;
  else if (claimed && claimed !== actor.label) {
    note = `${note ? note + "\n" : ""}Tester as claimed by the caller (not verified): ${claimed}`.slice(0, 5000);
  }
  const evidence = {
    change_request_id: cr.id,
    evidence_type: input.evidence_type,
    evidence_result: input.evidence_result ?? null,
    tested_by_label: testedBy,
    tested_at: input.tested_at ?? new Date().toISOString(),
    evidence_note: note,
  };

  if (input.document_id) {
    const { data: existing, error: fetchError } = await db
      .from("documents")
      .select("*")
      .eq("id", input.document_id)
      .eq("workspace_id", actor.workspaceId)
      .maybeSingle();
    if (fetchError) throw new Error(fetchError.message);
    if (!existing) throw new NotFoundError("Document not found");

    if (existing.change_request_id && existing.change_request_id !== cr.id) {
      throw new RuleError(
        "This document is already evidence for a different change request. Unlink it there first (PATCH /api/documents/:id with change_request_id null), or attach a new document.",
        "evidence_linked_elsewhere",
      );
    }
    await assertEvidenceLink(db, actor.workspaceId, existing, evidence);

    // W2-12: compare-and-set on the row we just read. If anything changed it meanwhile (a concurrent link
    // included) the write is refused with a 412; we re-read and report a link to another request as such.
    const linkedElsewhere = new RuleError(
      "This document is already evidence for a different change request. Unlink it there first (PATCH /api/documents/:id with change_request_id null), or attach a new document.",
      "evidence_linked_elsewhere",
    );
    try {
      const { after } = await auditedUpdate({
        table: "documents",
        actor,
        action: "document.update",
        id: input.document_id,
        patch: evidence,
        expectedUpdatedAt: (existing.updated_at as string | null) ?? undefined,
        ...(existing.change_request_id ? {} : { requireNull: "change_request_id" }),
        notFoundMessage: "Document not found",
      });
      return ok(after);
    } catch (e) {
      if (!(e instanceof PreconditionFailedError)) throw e;
      const { data: now, error: rereadError } = await db
        .from("documents")
        .select("change_request_id")
        .eq("id", input.document_id)
        .eq("workspace_id", actor.workspaceId)
        .maybeSingle();
      if (rereadError) throw new Error(rereadError.message);
      if (now?.change_request_id && now.change_request_id !== cr.id) throw linkedElsewhere;
      throw e;
    }
  }

  // New evidence document, filed under the request's project (the link check requires the same project).
  await assertEvidenceLink(db, actor.workspaceId, null, { project_id: cr.project_id, ...evidence });
  const { data: inserted, error } = await insertWithReference(db, actor.workspaceId, "document", (refId) =>
    asInsertResult(
      auditedInsert({
        table: "documents",
        actor,
        action: "document.create",
        patch: {
          project_id: cr.project_id,
          reference_id: refId,
          folder: input.folder ?? "General",
          title: input.title,
          doc_type: input.doc_type ?? "other",
          status: "draft",
          summary: input.summary ?? null,
          body: input.body ?? null,
          external_url: input.external_url ?? null,
          owner_id: null,
          ...evidence,
          created_by: actor.type === "user" ? actor.id : null,
        },
      }),
    ),
  );
  if (error || !inserted) throw new Error(error?.message ?? "Insert failed");
  return created(inserted);
});
