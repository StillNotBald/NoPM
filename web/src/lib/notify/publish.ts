import { createAdminClient } from "@/lib/supabase/admin";
import { eligibleRoles, loadApprovalPolicy } from "@/lib/governance/tiers";

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
  | "member.mfa_reset"
  /** A task, risk or issue has had no update for the workspace's stale threshold (R-141). */
  | "item.stale"
  /** The weekly status report was generated; the payload links to the rendered view (R-142). */
  | "report.weekly"
  /** A request is waiting and the turnaround is half gone (G3). */
  | "approval.reminder"
  /** A request passed its turnaround with no decision, or an emergency change is overdue for its retro decision (G3, G4). */
  | "approval.escalated"
  /** A routine request was approved by workspace policy because nobody decided in time (G3). */
  | "approval.auto_approved";

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

export type NotifyEachInput = Omit<NotifyInput, "recipientIds" | "workspaceId"> & { recipientId: string };

/**
 * Fail-soft batch variant of notify() for one message PER recipient (each with
 * its own title/body/payload): ONE membership lookup and ONE insert for the lot,
 * instead of a lookup per message. Same workspace-membership rule as notify().
 * Returns how many rows were written (0 on any failure, which is logged).
 */
export async function notifyEach(workspaceId: string, items: NotifyEachInput[]): Promise<number> {
  if (items.length === 0) return 0;
  try {
    const db = createAdminClient();
    const ids = [...new Set(items.map((i) => i.recipientId))];
    const { data: members, error: memberError } = await db
      .from("profiles")
      .select("id")
      .eq("workspace_id", workspaceId)
      .in("id", ids);
    if (memberError) {
      console.error("[notify] recipient lookup error:", memberError.message);
      return 0;
    }
    const allowed = new Set((members ?? []).map((m: { id: string }) => m.id));
    const rows = items
      .filter((i) => allowed.has(i.recipientId))
      .map((i) => ({
        workspace_id: workspaceId,
        recipient_id: i.recipientId,
        type: i.type,
        title: i.title,
        body: i.body ?? null,
        payload: i.payload ?? null,
      }));
    if (rows.length === 0) return 0;
    const { error } = await db.from("notifications").insert(rows);
    if (error) {
      console.error("[notify] insert error:", error.message);
      return 0;
    }
    return rows.length;
  } catch (err) {
    console.error("[notify] unexpected error:", err);
    return 0;
  }
}

/**
 * Resolve all workspace members whose role is 'admin' or 'manager'.
 * Returns their profile IDs (uuid). Used to fan-out governance notifications.
 */
export async function resolveWorkspaceApprovers(
  workspaceId: string,
  opts: { tier?: string | null; assignedApproverId?: string | null } = {},
): Promise<string[]> {
  try {
    const db = createAdminClient();
    // G2: with a tier, only the roles the workspace policy asks for. An admin tier goes to admins
    // only; a manager tier goes to managers and admins. Without a tier: both, as before.
    const roles = opts.tier ? eligibleRoles(opts.tier, await loadApprovalPolicy(db, workspaceId)) : ["admin", "manager"];
    const { data, error } = await db.from("profiles").select("id").eq("workspace_id", workspaceId).in("role", roles);
    if (error || !data) return [];
    const ids = data.map((p: { id: string }) => p.id);
    // G5: a named approver gets it alone, but only when they are eligible for the tier.
    if (opts.assignedApproverId && ids.includes(opts.assignedApproverId)) return [opts.assignedApproverId];
    return ids;
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
