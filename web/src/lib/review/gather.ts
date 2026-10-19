/**
 * lib/review/gather.ts
 *
 * Unified Review Queue — aggregates every item that needs a human decision
 * from existing tables (no new table). The caller passes an RLS-scoped
 * Supabase client so workspace isolation is automatic.
 *
 * Sources:
 *   deletion_requests  status='pending'              → kind 'approval'
 *   rebaselines        status='pending_approval'     → kind 'rebaseline'
 *   documents          status='in_review'            → kind 'document'   (defensive: table may not exist yet)
 *   risks              severity in (high|critical)
 *                      status not in (closed|mitigated)→ kind 'risk'
 *   clashes            status not in (resolved|closed)→ kind 'clash'
 *
 * Priority order:
 *   1. approval   (maker-checker — blocking)
 *   2. rebaseline (timeline governance — blocking)
 *   3. risk       critical first, then high, then oldest
 *   4. clash      oldest first
 *   5. document   oldest first
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DecideState } from "@/components/governance/four-eyes-note";
import { deletionKindFor } from "@/lib/integrations/types";
import { describeChildCounts, describeDeletionTarget, type ChildCountLine } from "./deletion-target";
import { judgeDecision, judgeRebaselineSignoff, type Viewer } from "./four-eyes";
import { clip } from "./pending";

// ── ReviewItem shape ──────────────────────────────────────────────────────────

export type ReviewKind = "approval" | "rebaseline" | "change" | "risk" | "clash" | "document";

export interface ReviewItem {
  /** Unique row id from source table */
  id: string;
  kind: ReviewKind;
  /** Human-readable title/summary */
  title: string;
  /** Project name (if available) */
  project?: string;
  /** Severity for risks (critical|high|medium|low) */
  severity?: string;
  /** How old this item is in calendar days */
  ageDays: number;
  /** UAT-005: approval tier, the decision deadline and whether it has passed (the queue shows all three). */
  tier?: string;
  deadline?: string | null;
  overdue?: boolean;
  /** Deep-link href the row should navigate to */
  href: string;
  /** CTA label shown in the action column */
  actionLabel: string;

  // ── Inline-action fields (kind === 'approval') ────────────────────────────
  /** The type of resource being deleted (e.g. "task") */
  targetType?: string;
  /** The id of the resource being deleted */
  targetId?: string;
  /** Label of the person who raised the deletion request */
  requestedByLabel?: string;
  /** Requester's stated reason for deletion */
  deletionReason?: string | null;
  /** Name of the record being deleted, from the request's `before` snapshot */
  targetName?: string;
  /** Project the target lives in (by name) */
  targetProject?: string;
  /** Project deletions: what approving also deletes (non-zero child counts). */
  childCounts?: ChildCountLine[];

  // ── Inline-action fields (kind === 'change') ──────────────────────────────
  /** Current status of the change request */
  crStatus?: string;
  /** What the approver needs beside the decision: who asked, how big, why. */
  change?: ChangeSummary;

  // ── Four-eyes (approval / change) ─────────────────────────────
  /**
   * May the signed-in viewer decide this, and if not, why — worked out on the
   * server the way the API decides (see ./four-eyes). Absent when the gatherer
   * was not told who is looking; the UI then offers the action as before.
   */
  decide?: DecideState;

}

/** The change request as the approver sees it in the inspector (read-only). */
export interface ChangeSummary {
  reference: string | null;
  priority: string | null;
  category: string | null;
  requestedBy: string | null;
  impactSummary: string | null;
  impactScheduleDays: number | null;
  impactCost: number | null;
  description: string | null;
  raisedAt: string | null;
  targetDate: string | null;
  /** Sent back with the decision so an edit made after opening is refused (412), not approved unseen. */
  updatedAt: string | null;
  projectId: string | null;
}

// ── helpers ───────────────────────────────────────────────────────────────────

// A `select("*")` row: the columns the verdict reads vary by migration level.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseRow = Record<string, any>;

/** The tier, deadline and overdue flag of a governed request row (absent columns read as nothing). */
function tierFields(row: { tier?: unknown; approval_deadline_at?: unknown; is_emergency?: unknown }): Pick<ReviewItem, "tier" | "deadline" | "overdue"> {
  const tier = row.is_emergency === true ? "emergency" : typeof row.tier === "string" && row.tier ? row.tier : undefined;
  const deadline = typeof row.approval_deadline_at === "string" ? row.approval_deadline_at : null;
  return { tier, deadline, overdue: deadline !== null && Date.parse(deadline) < Date.now() };
}

function ageDays(createdAt: string): number {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/** Numeric sort weight — lower = higher priority */
function weight(item: ReviewItem): number {
  const kindWeight: Record<ReviewKind, number> = {
    approval: 0,
    rebaseline: 1,
    change: 2,
    risk: 3,
    clash: 4,
    document: 5,
  };
  const base = kindWeight[item.kind] * 10_000;

  if (item.kind === "risk") {
    // critical < high; then older floats up (higher ageDays = higher priority within tier)
    const sevOrd = item.severity === "critical" ? 0 : 1;
    return base + sevOrd * 1_000 - Math.min(item.ageDays, 999);
  }

  // For everything else: older items float up (higher ageDays = higher priority)
  return base - Math.min(item.ageDays, 999);
}

// ── gather ────────────────────────────────────────────────────────────────────

export async function gatherReviewItems(
  db: SupabaseClient,
  /** The signed-in person; when given, decision items carry a server-computed `decide`. */
  viewer?: Viewer,
): Promise<ReviewItem[]> {
  // Build a project-id → name map for enrichment
  const { data: projectRows } = await db
    .from("projects")
    .select("id, name, code, is_locked");

  const lockedProjectIds = new Set<string>(
    (projectRows ?? []).filter((p: { is_locked?: boolean }) => p.is_locked).map((p: { id: string }) => p.id),
  );
  const projectMap = new Map<string, string>(
    (projectRows ?? []).map((p: { id: string; name: string }) => [p.id, p.name]),
  );

  // Fan out all queries in parallel
  const [
    deletionsResult,
    rebaselinesResult,
    risksResult,
    clashesResult,
    documentsResult,
    changeRequestsResult,
  ] = await Promise.allSettled([
    // 1. Deletion requests pending approval. `*` (not a column list): the verdict
    //    needs the requester columns and the `before` snapshot names the target.
    db
      .from("deletion_requests")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true }),

    // 2. Rebaselines pending sign-off
    db
      .from("rebaselines")
      .select("id, project_id, reason, created_at, requested_by, requested_principal_id, tier, approval_deadline_at")
      .eq("status", "pending_approval")
      .order("created_at", { ascending: true }),

    // 3. High / critical open risks
    db
      .from("risks")
      .select("id, title, severity, status, project_id, reference_id, created_at")
      .in("severity", ["high", "critical"])
      .not("status", "in", '("closed","accepted")')
      .order("created_at", { ascending: true }),

    // 4. Unresolved clashes
    db
      .from("clashes")
      .select("id, title, severity, project_a_id, created_at")
      .not("status", "in", '("resolved")')
      .order("created_at", { ascending: true }),

    // 5. Documents in_review (defensive — table may not exist yet)
    (async () => {
      try {
        return await db
          .from("documents")
          .select("id, title, project_id, created_at")
          .eq("status", "in_review")
          .order("created_at", { ascending: true });
      } catch {
        return { data: null, error: null };
      }
    })(),

    // 6. Change requests awaiting a decision: BOTH 'raised' (the default a new
    //    request is created in — nothing moves it on automatically) and
    //    'under_review', the same pair the decision route accepts
    //    (defensive — table may not exist yet)
    (async () => {
      try {
        return await db
          .from("change_requests")
          .select("*")
          .in("status", ["raised", "under_review"])
          .order("created_at", { ascending: true });
      } catch {
        return { data: null, error: null };
      }
    })(),

  ]);

  const items: ReviewItem[] = [];

  // ── Deletions ────────────────────────────────────────────────────────────────
  if (deletionsResult.status === "fulfilled") {
    for (const row of deletionsResult.value.data ?? []) {
      const target = describeDeletionTarget(row);
      items.push({
        id: row.id,
        kind: "approval",
        // Name the record, not just its type: "Delete task: Cutover plan — <reason>"
        title: `Delete ${row.target_type}${target.name ? `: ${target.name}` : ""}${row.reason ? ` — ${row.reason}` : ""}`,
        // A project's own name is the title already; only a task shows its project.
        project: target.type !== "project" && target.projectId ? projectMap.get(target.projectId) : undefined,
        ageDays: ageDays(row.created_at),
        href: "/approvals",
        actionLabel: "Approve / reject",
        ...tierFields(row),
        // inline-action fields
        targetType: row.target_type,
        targetId: row.target_id,
        targetName: target.name ?? undefined,
        targetProject: target.type !== "project" && target.projectId ? projectMap.get(target.projectId) : undefined,
        requestedByLabel: row.requested_by_label ?? undefined,
        deletionReason: row.reason ?? null,
        decide: viewer
          ? judgeDecision({
              viewer,
              kind: deletionKindFor(row.target_type),
              row,
              projectLocked: !!target.projectId && lockedProjectIds.has(target.projectId),
            })
          : undefined,
        childCounts:
          row.target_type === "project" || row.target_type === "milestone"
            ? describeChildCounts(row.before, row.target_type)
            : undefined,
      });
    }
  }

  // ── Rebaselines ──────────────────────────────────────────────────────────────
  if (rebaselinesResult.status === "fulfilled") {
    for (const row of rebaselinesResult.value.data ?? []) {
      const projectName = row.project_id ? projectMap.get(row.project_id) : undefined;
      items.push({
        id: row.id,
        kind: "rebaseline",
        title: `Rebaseline sign-off${row.reason ? ` — ${row.reason}` : ""}`,
        project: projectName,
        ageDays: ageDays(row.created_at),
        // D1: the governed sign-off / apply controls live on /baselines.
        href: `/baselines?focus=${row.id}`,
        actionLabel: "Sign off",
        ...tierFields(row),
        decide: viewer ? judgeRebaselineSignoff(viewer, row) : undefined,
      });
    }
  }

  // ── Risks ────────────────────────────────────────────────────────────────────
  if (risksResult.status === "fulfilled") {
    for (const row of risksResult.value.data ?? []) {
      const projectName = row.project_id ? projectMap.get(row.project_id) : undefined;
      items.push({
        id: row.id,
        kind: "risk",
        title: row.title,
        project: projectName,
        severity: row.severity,
        ageDays: ageDays(row.created_at),
        href: "/risks",
        actionLabel: "Review risk",
      });
    }
  }

  // ── Clashes ──────────────────────────────────────────────────────────────────
  if (clashesResult.status === "fulfilled") {
    for (const row of clashesResult.value.data ?? []) {
      const projectName = row.project_a_id ? projectMap.get(row.project_a_id) : undefined;
      items.push({
        id: row.id,
        kind: "clash",
        title: row.title,
        project: projectName,
        severity: row.severity,
        ageDays: ageDays(row.created_at),
        href: "/clashes",
        actionLabel: "Resolve clash",
      });
    }
  }

  // ── Documents (defensive) ────────────────────────────────────────────────────
  if (documentsResult.status === "fulfilled") {
    for (const row of (documentsResult.value as { data: Array<{ id: string; title: string; project_id: string | null; created_at: string }> | null }).data ?? []) {
      const projectName = row.project_id ? projectMap.get(row.project_id) : undefined;
      items.push({
        id: row.id,
        kind: "document",
        title: row.title,
        project: projectName,
        ageDays: ageDays(row.created_at),
        href: `/documents?doc=${row.id}`,
        actionLabel: "Review document",
      });
    }
  }

  // ── Change requests (defensive) ──────────────────────────────────────────────
  if (changeRequestsResult.status === "fulfilled") {
    for (const row of (changeRequestsResult.value as { data: LooseRow[] | null }).data ?? []) {
      const projectName = row.project_id ? projectMap.get(row.project_id) : undefined;
      items.push({
        id: row.id,
        kind: "change",
        title: row.title,
        project: projectName,
        ageDays: ageDays(row.created_at),
        href: `/change-control?cr=${row.id}`,
        actionLabel: "Decide",
        ...tierFields(row),
        // inline-action fields
        crStatus: row.status,
        change: {
          reference: row.reference_id ?? null,
          priority: row.priority ?? null,
          category: row.category ?? null,
          requestedBy: row.requested_by_label ?? null,
          impactSummary: clip(row.impact_summary, 400),
          impactScheduleDays: typeof row.impact_schedule_days === "number" ? row.impact_schedule_days : null,
          impactCost: typeof row.impact_cost === "number" ? row.impact_cost : null,
          description: clip(row.description, 600),
          raisedAt: row.raised_at ?? row.created_at ?? null,
          targetDate: row.target_date ?? null,
          updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
          projectId: row.project_id ?? null,
        },
        decide: viewer ? judgeDecision({ viewer, kind: "change_request", row }) : undefined,
      });
    }
  }

  // Sort by priority weight (ascending = highest priority first)
  items.sort((a, b) => weight(a) - weight(b));

  return items;
}
