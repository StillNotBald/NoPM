import { route } from "@/lib/api/handler";
import { created, okList, safeJson, validationError } from "@/lib/api/response";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit/write";
import { createDocumentSchema } from "@/app/api/documents/_schema";
import { assertRefsInWorkspace } from "@/lib/api/workspace-refs";

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

  // Cross-tenant guard: the project and the owner (a profile) must both
  // belong to THIS workspace.
  await assertRefsInWorkspace(db, actor.workspaceId, [
    { table: "projects", id: input.project_id, field: "project_id" },
    { table: "profiles", id: input.owner_id, field: "owner_id" },
  ]);

  // Derive next DOC-NNN reference_id.
  const { data: existing } = await db
    .from("documents")
    .select("reference_id")
    .eq("workspace_id", actor.workspaceId)
    .not("reference_id", "is", null);

  let maxNum = 0;
  for (const row of existing ?? []) {
    const val = row.reference_id as string | null;
    if (!val) continue;
    const idx = val.lastIndexOf("-");
    if (idx === -1) continue;
    const n = parseInt(val.slice(idx + 1), 10);
    if (!isNaN(n) && n > maxNum) maxNum = n;
  }
  const refId = `DOC-${String(maxNum + 1).padStart(3, "0")}`;

  const { data: row, error } = await db
    .from("documents")
    .insert({
      workspace_id: actor.workspaceId,
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
      created_by:   actor.type === "user" ? actor.id : null,
    })
    .select()
    .single();

  if (error || !row) throw new Error(error?.message ?? "Insert failed");

  await writeAudit({
    workspaceId: actor.workspaceId,
    actor,
    action:     "document.create",
    targetType: "document",
    targetId:   row.id,
    before:     null,
    after:      row,
  });

  return created(row);
});
