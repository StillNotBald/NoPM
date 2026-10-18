import { route } from "@/lib/api/handler";
import { okList } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const EVIDENCE_COLUMNS =
  "id, reference_id, title, doc_type, status, version, project_id, change_request_id, evidence_type, evidence_result, tested_by_label, tested_at, evidence_note, external_url, file_name, mime_type, created_at, updated_at";

/**
 * GET /api/change-requests/:id/evidence — documents attached to this change
 * request as test / UAT / deploy evidence, newest test first. Workspace-scoped.
 * Read-only: attaching goes through POST/PATCH /api/documents (audited there).
 */
export const GET = route(async ({ actor, params }) => {
  requireScope(actor, "document:read");
  const db = createAdminClient();

  const { data: cr, error: crError } = await db
    .from("change_requests")
    .select("id")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .maybeSingle();
  if (crError) throw new Error(crError.message);
  if (!cr) throw new NotFoundError("Change request not found");

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
