import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { okList } from "@/lib/api/response";

export const runtime = "nodejs";

/**
 * GET /api/notifications
 * Returns the current session user's notifications (never token-caller facing).
 * Query params:
 *   ?unread=1        — only rows where read_at IS NULL
 *   ?limit=20        — page size (max 100)
 *   ?page=1          — 1-based page index
 *
 * Response: { data: [...], total, page, limit }
 */
export const GET = route(async ({ actor, request }) => {
  requireScope(actor, "notification:read");

  const { searchParams } = new URL(request.url);
  const unreadOnly = searchParams.get("unread") === "1";
  const rawLimit = parseInt(searchParams.get("limit") ?? "20", 10);
  const rawPage = parseInt(searchParams.get("page") ?? "1", 10);
  const limit = Math.min(100, Math.max(1, isNaN(rawLimit) ? 20 : rawLimit));
  const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage);
  const offset = (page - 1) * limit;

  const db = createAdminClient();

  let query = db
    .from("notifications")
    .select("*", { count: "exact" })
    .eq("workspace_id", actor.workspaceId)
    .eq("recipient_id", actor.id);

  if (unreadOnly) {
    query = query.is("read_at", null);
  }

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw new Error(error.message);

  return okList(data ?? [], { total: count ?? 0, page, limit });
});
