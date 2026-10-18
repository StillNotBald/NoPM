import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Notification types used across NoPM governance flows.
 * Extend this union as new notification points are added.
 */
export type NotificationType =
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "risk.escalated"
  | "clash.detected"
  /** Your Lark account link was replaced by a newer link code (Integration Hub). */
  | "integration.link_replaced"
  /** An admin reset your two-step sign-in; use a backup code to sign in. */
  | "member.mfa_reset";

export type NotifyInput = {
  workspaceId: string;
  recipientIds: string[];
  type: NotificationType;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
};

/**
 * Fail-soft: insert one notifications row per recipientId.
 * Never throws into the caller's mutation — notifications are best-effort.
 * Uses the service-role client (bypasses RLS); inserts are workspace-scoped.
 */
export async function notify(input: NotifyInput): Promise<void> {
  if (!input.recipientIds || input.recipientIds.length === 0) return;

  try {
    const db = createAdminClient();
    // Only ever notify members of THIS workspace: a recipient id can come from
    // a client-supplied field (e.g. an owner_id), and a notification row is
    // readable by its recipient, so an unchecked id would let one tenant drop
    // messages into another tenant's inbox. Fail-soft like the rest of notify().
    const { data: members, error: memberError } = await db
      .from("profiles")
      .select("id")
      .eq("workspace_id", input.workspaceId)
      .in("id", [...new Set(input.recipientIds)]);
    if (memberError) {
      console.error("[notify] recipient lookup error:", memberError.message);
      return;
    }
    const allowed = new Set((members ?? []).map((m: { id: string }) => m.id));
    const recipientIds = [...new Set(input.recipientIds)].filter((id) => allowed.has(id));
    if (recipientIds.length === 0) return;
    const rows = recipientIds.map((recipientId) => ({
      workspace_id: input.workspaceId,
      recipient_id: recipientId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      payload: input.payload ?? null,
    }));
    const { error } = await db.from("notifications").insert(rows);
    if (error) {
      console.error("[notify] insert error:", error.message);
    }
  } catch (err) {
    console.error("[notify] unexpected error:", err);
  }
}

/**
 * Resolve all workspace members whose role is 'admin' or 'manager'.
 * Returns their profile IDs (uuid). Used to fan-out governance notifications.
 */
export async function resolveWorkspaceApprovers(workspaceId: string): Promise<string[]> {
  try {
    const db = createAdminClient();
    const { data, error } = await db
      .from("profiles")
      .select("id")
      .eq("workspace_id", workspaceId)
      .in("role", ["admin", "manager"]);
    if (error || !data) return [];
    return data.map((p: { id: string }) => p.id);
  } catch {
    return [];
  }
}

/**
 * Resolve the owner of a project (profiles.id where projects.owner_id = profile.id).
 * Returns null when the project has no owner or the lookup fails.
 */
export async function resolveProjectOwner(
  workspaceId: string,
  projectId: string,
): Promise<string | null> {
  try {
    const db = createAdminClient();
    const { data, error } = await db
      .from("projects")
      .select("owner_id")
      .eq("id", projectId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error || !data || !data.owner_id) return null;
    return data.owner_id as string;
  } catch {
    return null;
  }
}
