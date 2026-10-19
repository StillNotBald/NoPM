/**
 * The daily approval timer (audit gaps G3 and G4, migration 0101).
 *
 * Runs inside the scheduler tick (lib/integrations/cron.ts), once per workspace:
 *   1. REMINDER   halfway through a request's turnaround, the people who may decide its tier
 *                 get a reminder (once).
 *   2. AUTO-APPROVE past the deadline, a ROUTINE change request is approved by policy, but only
 *                 when an admin switched `tiers.routine.auto_approve` on (OFF by default). The
 *                 decision is the database function nopm_auto_approve_routine: one transaction,
 *                 one audit row, and it refuses any tier but routine and any request carrying
 *                 money or dates.
 *   3. ESCALATION past the deadline and not auto-approved, the admins are told (once).
 * (The old fourth step, the emergency retro flag, was retired by owner decision Q1: an emergency change commits
 * when it is raised and owes no retro decision.)
 * Each step is recorded in `approval_events`; its unique index (target, kind) is the once-only
 * rule, so a second tick on the same day cannot remind, escalate or flag twice. The timer never
 * writes to the request row itself, so it cannot invalidate the version an approver is reading.
 *
 * One `approval.timer_run` audit row is written per workspace per run in which the timer looked
 * at, or did, anything; a workspace with nothing waiting writes nothing (no mutation, no row).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAudit, systemActor } from "@/lib/audit/write";
import { sanitizeError } from "@/lib/integrations/secrets";
import { notify, resolveWorkspaceApprovers } from "@/lib/notify/publish";
import { announceDecided, changeRequestEvent } from "@/lib/governance/decide";
import { recordApprovalEvent, type ApprovalTarget } from "@/lib/governance/approval-events";
import { loadApprovalPolicy, reminderDueAt, type ApprovalPolicy } from "@/lib/governance/tiers";

type Db = ReturnType<typeof createAdminClient>;

const PAGE = 200;
const ITEM_LIMIT = 500;
const MAX_PAGES = 20;

export type ApprovalTimerSummary = {
  workspaces: number;
  /** Requests the timer looked at (waiting with a deadline). */
  examined: number;
  reminders: number;
  escalated: number;
  autoApproved: number;
  failed: number;
  skippedForDeadline: number;
};

export const EMPTY_APPROVAL_TIMER_STEP: ApprovalTimerSummary = {
  workspaces: 0,
  examined: 0,
  reminders: 0,
  escalated: 0,
  autoApproved: 0,
  failed: 0,
  skippedForDeadline: 0,
};

export type TimerCounts = Pick<ApprovalTimerSummary, "examined" | "reminders" | "escalated" | "autoApproved" | "failed">;

type Waiting = {
  id: string;
  target: ApprovalTarget;
  tier: string;
  raisedAt: string;
  deadline: string;
  requesterPrincipalId: string | null;
  assignedApproverId: string | null;
  label: string;
  row: Record<string, unknown>;
};

type PageResult = { data: unknown; error: { message: string } | null };

/**
 * Every row of a query, in pages (W4-25): ordered and ranged, so a workspace with more than one page of
 * waiting items still has its whole tail looked at. Stops at MAX_PAGES (10,000 rows) as a safety net.
 */
async function fetchAll(page: (from: number, to: number) => PromiseLike<PageResult>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const { data, error } = await page(i * ITEM_LIMIT, (i + 1) * ITEM_LIMIT - 1);
    if (error) throw error;
    const rows = (data ?? []) as Record<string, unknown>[];
    out.push(...rows);
    if (rows.length < ITEM_LIMIT) break;
  }
  return out;
}

async function loadWaiting(db: Db, workspaceId: string): Promise<Waiting[]> {
  const out: Waiting[] = [];

  const crs = await fetchAll((a, b) =>
    db
      .from("change_requests")
      .select("*")
      .eq("workspace_id", workspaceId)
      .in("status", ["raised", "under_review"])
      .not("approval_deadline_at", "is", null)
      .order("approval_deadline_at", { ascending: true })
      .order("id", { ascending: true })
      .range(a, b),
  );
  for (const r of crs) {
    out.push({
      id: String(r.id),
      target: "change_request",
      tier: String(r.tier ?? "normal"),
      raisedAt: String(r.raised_at ?? r.created_at),
      deadline: String(r.approval_deadline_at),
      requesterPrincipalId: (r.requested_principal_id as string | null) ?? null,
      assignedApproverId: (r.assigned_approver_id as string | null) ?? null,
      label: `Change request ${r.reference_id ?? r.id}: ${r.title ?? ""}`.trim(),
      row: r,
    });
  }

  const dels = await fetchAll((a, b) =>
    db
      .from("deletion_requests")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("status", "pending")
      .not("approval_deadline_at", "is", null)
      .order("approval_deadline_at", { ascending: true })
      .order("id", { ascending: true })
      .range(a, b),
  );
  for (const r of dels) {
    const name = (r.before as { name?: string } | null)?.name ?? r.target_id;
    out.push({
      id: String(r.id),
      target: "deletion_request",
      tier: String(r.tier ?? "normal"),
      raisedAt: String(r.created_at),
      deadline: String(r.approval_deadline_at),
      requesterPrincipalId: (r.requested_principal_id as string | null) ?? null,
      assignedApproverId: (r.assigned_approver_id as string | null) ?? null,
      label: `Delete ${r.target_type} "${name}"`,
      row: r,
    });
  }

  const rbs = await fetchAll((a, b) =>
    db
      .from("rebaselines")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("status", "pending_approval")
      .not("approval_deadline_at", "is", null)
      .order("approval_deadline_at", { ascending: true })
      .order("id", { ascending: true })
      .range(a, b),
  );
  for (const r of rbs) {
    out.push({
      id: String(r.id),
      target: "rebaseline",
      tier: String(r.tier ?? "normal"),
      raisedAt: String(r.created_at),
      deadline: String(r.approval_deadline_at),
      requesterPrincipalId: (r.requested_principal_id as string | null) ?? null,
      assignedApproverId: (r.assigned_approver_id as string | null) ?? null,
      label: `Rebaseline v${r.version ?? ""}`.trim(),
      row: r,
    });
  }
  return out;
}

/** The escalation audience: the workspace admins, whatever the tier policy says. */
async function adminIds(db: Db, workspaceId: string): Promise<string[]> {
  const { data, error } = await db.from("profiles").select("id").eq("workspace_id", workspaceId).eq("role", "admin");
  if (error || !data) return [];
  return (data as { id: string }[]).map((p) => p.id);
}

/** The timer pass for one workspace. Never throws for a single bad request: it counts it as failed. */
export async function runApprovalTimersForWorkspace(workspaceId: string, now: Date, policyIn?: ApprovalPolicy): Promise<TimerCounts> {
  const db = createAdminClient();
  const policy = policyIn ?? (await loadApprovalPolicy(db, workspaceId));
  const counts: TimerCounts = { examined: 0, reminders: 0, escalated: 0, autoApproved: 0, failed: 0 };

  const waiting = await loadWaiting(db, workspaceId);
  for (const w of waiting) {
    counts.examined += 1;
    try {
      const deadline = Date.parse(w.deadline);
      if (Number.isNaN(deadline)) continue;

      if (now.getTime() < deadline) {
        // Halfway through the turnaround: remind the people who can decide it, once.
        if (now.getTime() >= reminderDueAt(w.raisedAt, w.deadline).getTime()) {
          const first = await recordApprovalEvent(db, {
            workspaceId,
            targetType: w.target,
            targetId: w.id,
            kind: "reminder_sent",
            detail: { tier: w.tier, deadline: w.deadline },
          });
          if (first) {
            const to = (await resolveWorkspaceApprovers(workspaceId, { tier: w.tier, assignedApproverId: w.assignedApproverId })).filter(
              (id) => id !== w.requesterPrincipalId,
            );
            await notify({
              workspaceId,
              recipientIds: to,
              type: "approval.reminder",
              title: `Waiting for your decision: ${w.label}`,
              body: `Half of the turnaround has passed. A decision is due by ${w.deadline.slice(0, 16).replace("T", " ")} UTC.`,
              payload: { href: "/approvals", targetType: w.target, targetId: w.id, tier: w.tier },
            });
            counts.reminders += 1;
          }
        }
        continue;
      }

      // Past the deadline. Routine change requests are auto-approved when, and only when, the policy says so.
      if (w.target === "change_request" && w.tier === "routine" && policy.tiers.routine.auto_approve) {
        const { data, error } = await db.rpc("nopm_auto_approve_routine", {
          p_workspace_id: workspaceId,
          p_id: w.id,
          p_now: now.toISOString(),
        });
        if (!error) {
          counts.autoApproved += 1;
          const approved = (data ?? w.row) as Record<string, unknown> & { id: string };
          await notify({
            workspaceId,
            recipientIds: w.requesterPrincipalId ? [w.requesterPrincipalId] : [],
            type: "approval.auto_approved",
            title: `${w.label} was approved by policy`,
            body: "Nobody decided within the turnaround, so the workspace policy approved this routine change.",
            payload: { href: "/approvals", changeRequestId: w.id },
          });
          try {
            const ev = await changeRequestEvent(db, workspaceId, approved as never);
            announceDecided({ ...ev, status: "approved", decidedByLabel: "auto-approve (policy)", channel: "api" });
          } catch (err) {
            console.error("[approvals] could not retire the approval cards:", sanitizeError(err));
          }
          continue;
        }
        // Not eligible (money or dates, decided meanwhile, policy changed): fall through to escalation.
        const code = (error as { code?: string }).code;
        // P0031 off, P0032 not routine, P0033 not due (0101); P0001 already decided.
        if (code !== "P0031" && code !== "P0032" && code !== "P0033" && code !== "P0001") throw error;
      }

      const first = await recordApprovalEvent(db, {
        workspaceId,
        targetType: w.target,
        targetId: w.id,
        kind: "escalated",
        detail: { tier: w.tier, deadline: w.deadline },
      });
      if (first) {
        await notify({
          workspaceId,
          recipientIds: await adminIds(db, workspaceId),
          type: "approval.escalated",
          title: `Overdue: ${w.label}`,
          body: `No decision before ${w.deadline.slice(0, 16).replace("T", " ")} UTC.`,
          payload: { href: "/approvals", targetType: w.target, targetId: w.id, tier: w.tier },
        });
        counts.escalated += 1;
      }
    } catch (err) {
      console.error("[approvals] timer failed for a request:", sanitizeError(err));
      counts.failed += 1;
    }
  }

  if (counts.examined > 0 || counts.failed > 0) {
    await writeAudit({
      workspaceId,
      actor: systemActor(workspaceId, "approval-timer", { requestId: "cron" }),
      action: "approval.timer_run",
      targetType: "workspace",
      targetId: workspaceId,
      before: null,
      after: { ...counts, ran_at: now.toISOString() },
    });
  }
  return counts;
}

/** The scheduler step: walks every workspace (keyset-paged) and stops STARTING a workspace at the deadline. */
export async function runApprovalTimerStep(now: Date, deadline: number): Promise<ApprovalTimerSummary> {
  const summary: ApprovalTimerSummary = { ...EMPTY_APPROVAL_TIMER_STEP };
  const db = createAdminClient();
  let after: string | null = null;
  for (;;) {
    let q = db.from("workspaces").select("id").order("id", { ascending: true }).limit(PAGE);
    if (after) q = q.gt("id", after);
    const { data, error } = await q;
    if (error) {
      console.error("[approvals] workspace listing failed:", sanitizeError(error));
      summary.failed += 1;
      return summary;
    }
    const page = (data ?? []) as { id: string }[];
    for (const ws of page) {
      summary.workspaces += 1;
      if (Date.now() >= deadline) {
        summary.skippedForDeadline += 1;
        continue;
      }
      try {
        const c = await runApprovalTimersForWorkspace(ws.id, now);
        summary.examined += c.examined;
        summary.reminders += c.reminders;
        summary.escalated += c.escalated;
        summary.autoApproved += c.autoApproved;
        summary.failed += c.failed;
      } catch (err) {
        console.error("[approvals] workspace timer step failed:", sanitizeError(err));
        summary.failed += 1;
      }
    }
    if (page.length < PAGE) return summary;
    after = page[page.length - 1].id;
  }
}

