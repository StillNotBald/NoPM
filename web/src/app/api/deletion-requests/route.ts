import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { okList } from "@/lib/api/response";

export const runtime = "nodejs";

const VALID_STATUSES = ["pending", "approved", "rejected", "committed"] as const;
type DeletionStatus = (typeof VALID_STATUSES)[number];

/**
 * GET /api/deletion-requests
 * List deletion requests for the actor's workspace, newest first.
 * Requires scope task:read OR audit:read (task:read is tried first).
 * Optional ?status filter (pending|approved|rejected|committed).
 * Paginated: ?limit (1..100, default 20) & ?page.
 */
export const GET = route(async ({ actor, request }) => {
  // Accept either task:read or audit:read — try task:read first
  try {
    requireScope(actor, "task:read");
  } catch {
    requireScope(actor, "audit:read");
  }

  const { searchParams } = new URL(request.url);
  const rawLimit = parseInt(searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(100, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
  const rawPage = parseInt(searchParams.get("page") ?? "1", 10);
  const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
  const offset = (page - 1) * limit;

  const statusParam = searchParams.get("status");
  const statusFilter =
    statusParam && (VALID_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as DeletionStatus)
      : null;

  const db = createAdminClient();

  // Count query
  let countQuery = db
    .from("deletion_requests")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", actor.workspaceId);
  if (statusFilter) {
    countQuery = countQuery.eq("status", statusFilter);
  }
  const { count, error: countError } = await countQuery;
  if (countError) throw new Error(countError.message);

  // Data query
  let dataQuery = db
    .from("deletion_requests")
    .select("*")
    .eq("workspace_id", actor.workspaceId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (statusFilter) {
    dataQuery = dataQuery.eq("status", statusFilter);
  }
  const { data, error } = await dataQuery;
  if (error) throw new Error(error.message);

  return okList(data ?? [], { total: count ?? 0, page, limit });
});
