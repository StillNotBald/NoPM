import type { createAdminClient } from "@/lib/supabase/admin";

type Db = ReturnType<typeof createAdminClient>;

// "retro_overdue" is HISTORY only: rows written before the retro was retired (Q1) stay readable and the DB CHECK still
// allows the value. Nothing writes it any more. Removing it from the CHECK is a later migration (see rtm/w5i.md).
export type ApprovalEventKind = "deadline_set" | "reminder_sent" | "escalated" | "auto_approved" | "retro_overdue";
export type ApprovalTarget = "change_request" | "deletion_request" | "rebaseline";

/**
 * Writes one row of the approval timer ledger (migration 0101, `approval_events`).
 *
 * The ledger is bookkeeping about what the daily timer did (or what deadline a request was
 * given), NOT a governed mutation: the governed facts (the raise, the decision) carry their own
 * audit rows. One row per (target, kind) is the "once" rule, so a unique violation is the normal
 * answer to "already done" and is reported as `false`, not as a failure. Any other failure is
 * logged and returned as `false`: a missing ledger row must never fail a raise or a cron run.
 *
 * Returns true when THIS call wrote the row, which is how the timer knows it should notify.
 */
export async function recordApprovalEvent(
  db: Db,
  e: {
    workspaceId: string;
    targetType: ApprovalTarget;
    targetId: string;
    kind: ApprovalEventKind;
    actorLabel?: string;
    detail?: Record<string, unknown>;
  },
): Promise<boolean> {
  try {
    const { error } = await db.from("approval_events").insert({
      workspace_id: e.workspaceId,
      target_type: e.targetType,
      target_id: e.targetId,
      kind: e.kind,
      ...(e.actorLabel ? { actor_label: e.actorLabel } : {}),
      detail: e.detail ?? null,
    });
    if (error) {
      if (error.code !== "23505") console.error("[approvals] event not recorded:", error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[approvals] event not recorded:", err);
    return false;
  }
}
