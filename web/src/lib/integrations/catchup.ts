import { createAdminClient } from "@/lib/supabase/admin";
import { changeRequestEvent, timesheetEvent, projectNameOf } from "@/lib/governance/decide";
import { runApprovalRequested } from "@/lib/integrations/emit";
import { sanitizeError } from "@/lib/integrations/secrets";
import type { ApprovalEvent } from "@/lib/integrations/types";

/**
 * D-ACC-7: approval requests raised while the connector was paused (or before
 * it existed) never produced a card, so approvers learned nothing from chat.
 * When an admin RESUMES the connector, queue cards for every request that is
 * still pending.
 *
 * It reuses `runApprovalRequested`, so the same rules apply as for a fresh
 * request: only linked admins/managers, never the requester's own principal,
 * the hourly card budget (the surplus becomes one roll-up message), and the
 * open-card check, which skips any recipient who already holds a live card for
 * that request. A second resume, or a resume while some cards are still open,
 * therefore never produces a duplicate.
 *
 * Bounded per kind (oldest first, 25) and in total (60) and fail-soft per request: one broken row
 * never costs the others their card.
 */
export const CATCH_UP_LIMIT_PER_KIND = 25;
/** Hard cap on cards queued per resume, so the background task stays inside the function time limit. */
export const CATCH_UP_TOTAL_CAP = 60;

type Row = Record<string, unknown>;

export async function catchUpPendingApprovals(workspaceId: string): Promise<{ considered: number }> {
  const db = createAdminClient();
  const events: ApprovalEvent[] = [];

  const collect = async (label: string, build: () => PromiseLike<ApprovalEvent[]>): Promise<void> => {
    try {
      events.push(...(await build()));
    } catch (err) {
      console.error(`[integrations] resume catch-up (${label}) failed:`, sanitizeError(err));
    }
  };

  await collect("deletions", async () => {
    const { data, error } = await db
      .from("deletion_requests")
      .select("id, target_type, target_id, reason, before, requested_by_type, requested_by_label, requested_principal_id")
      .eq("workspace_id", workspaceId)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(CATCH_UP_LIMIT_PER_KIND);
    if (error) throw error;
    const out: ApprovalEvent[] = [];
    for (const r of (data ?? []) as Row[]) {
      const isProject = r.target_type === "project";
      if (!isProject && r.target_type !== "task") continue;
      const before = (r.before ?? {}) as Row;
      const name = typeof before.name === "string" ? before.name : String(r.target_id);
      const projectId = isProject ? String(r.target_id) : ((before.project_id as string | undefined) ?? null);
      out.push({
        workspaceId,
        kind: isProject ? "project_deletion" : "task_deletion",
        id: String(r.id),
        title: isProject ? `Delete project "${name}"` : `Delete task "${name}"`,
        summary: (r.reason as string | null) ?? null,
        projectId,
        projectName: isProject ? name : await projectNameOf(db, workspaceId, projectId),
        requestedByLabel: String(r.requested_by_label ?? ""),
        requesterPrincipalId: (r.requested_principal_id as string | null) ?? null,
      });
    }
    return out;
  });

  await collect("change requests", async () => {
    const { data, error } = await db
      .from("change_requests")
      .select("*")
      .eq("workspace_id", workspaceId)
      .in("status", ["raised", "under_review"])
      .order("created_at", { ascending: true })
      .limit(CATCH_UP_LIMIT_PER_KIND);
    if (error) throw error;
    const out: ApprovalEvent[] = [];
    for (const r of (data ?? []) as Row[]) out.push(await changeRequestEvent(db, workspaceId, r as never));
    return out;
  });

  await collect("timesheets", async () => {
    const { data, error } = await db
      .from("timesheet_submissions")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("status", "submitted")
      // A reopened sheet waits for the member to amend it, not for a decision.
      .is("reopened_at", null)
      .order("created_at", { ascending: true })
      .limit(CATCH_UP_LIMIT_PER_KIND);
    if (error) throw error;
    const out: ApprovalEvent[] = [];
    for (const r of (data ?? []) as Row[]) out.push(await timesheetEvent(db, workspaceId, r as never));
    return out;
  });

  for (const ev of events.slice(0, CATCH_UP_TOTAL_CAP)) {
    try {
      await runApprovalRequested(ev);
    } catch (err) {
      console.error("[integrations] resume catch-up card failed:", sanitizeError(err));
    }
  }
  return { considered: Math.min(events.length, CATCH_UP_TOTAL_CAP) };
}
