import { route } from "@/lib/api/handler";
import { requireScope } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok } from "@/lib/api/response";
import { NotFoundError } from "@/lib/api/errors";

export const runtime = "nodejs";

/**
 * PATCH /api/notifications/[id]
 * Mark a single notification as read (sets read_at = now()).
 * Only the owning recipient may mark their own notification.
 * Idempotent: if already read, returns the existing row unchanged.
 */
export const PATCH = route(async ({ actor, params }) => {
  // Mark-read is a personal action — all roles (including viewers) may clear own notifications
  requireScope(actor, "notification:read");

  const db = createAdminClient();

  // Verify ownership before updating (admin client bypasses RLS)
  const { data: existing, error: fetchError } = await db
    .from("notifications")
    .select("*")
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .eq("recipient_id", actor.id)
    .maybeSingle();

  if (fetchError) throw new Error(fetchError.message);
  if (!existing) throw new NotFoundError("Notification not found");

  // Idempotent: already read, return as-is
  if (existing.read_at) {
    return ok(existing);
  }

  const { data: updated, error: updateError } = await db
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", params.id)
    .eq("workspace_id", actor.workspaceId)
    .eq("recipient_id", actor.id)
    .select()
    .single();

  if (updateError || !updated) throw new Error(updateError?.message ?? "Update failed");

  return ok(updated);
});
