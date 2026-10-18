import { route } from "@/lib/api/handler";
import { okList } from "@/lib/api/response";
import { RuleError } from "@/lib/api/errors";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseListSelection } from "@/lib/api/views";

export const runtime = "nodejs";

const STATUSES = ["raised", "under_review", "approved", "rejected", "deferred", "implemented"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/change-requests — workspace-wide list of change requests, newest first.
 * Filters: project_id, status. Lean by default (view=summary); view=full or fields=...
 * for more. Read-only: raising one is POST /api/projects/:id/change-requests.
 */
export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "change:read");

  const url = new URL(request.url);
  const projectId = url.searchParams.get("project_id");
  const status = url.searchParams.get("status");
  if (projectId !== null && !UUID_RE.test(projectId)) throw new RuleError("project_id must be a UUID");
  if (status !== null && !(STATUSES as readonly string[]).includes(status)) {
    throw new RuleError(`Invalid status "${status}". Must be one of: ${STATUSES.join(", ")}`);
  }
  const { select } = parseListSelection(url.searchParams, "change_requests");

  const rawLimit = parseInt(url.searchParams.get("limit") ?? "20", 10);
  const rawPage = parseInt(url.searchParams.get("page") ?? "1", 10);
  const limit = Math.min(100, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
  const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
  const offset = (page - 1) * limit;

  const db = createAdminClient();
  let query = db.from("change_requests").select(select, { count: "exact" }).eq("workspace_id", actor.workspaceId);
  if (projectId) query = query.eq("project_id", projectId);
  if (status) query = query.eq("status", status);
  const { data: items, error, count } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message);
  return okList(items ?? [], { total: count ?? 0, page, limit });
});
