import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok } from "@/lib/api/response";

export const runtime = "nodejs";

/**
 * POST /api/notifications/read-all
 * Mark all unread notifications as read for the current session user.
 * Only affects rows where read_at IS NULL (unread). Idempotent.
 *
 * Response: { data: { updated: number } }
 */
export const POST = route(async ({ actor }) => {
  // Mark-all-read is a personal action — all roles (including viewers) may clear own notifications
  requireScope(actor, "notification:read");

  const db = createAdminClient();

  const { data, error } = await db
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("workspace_id", actor.workspaceId)
    .eq("recipient_id", actor.id)
    .is("read_at", null)
    .select("id");

  if (error) throw new Error(error.message);

  return ok({ updated: data?.length ?? 0 });
});
