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

// ── ReviewItem shape ──────────────────────────────────────────────────────────

export type ReviewKind = "approval" | "rebaseline" | "change" | "timesheet" | "risk" | "clash" | "document";

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

  // ── Inline-action fields (kind === 'change') ──────────────────────────────
  /** Current status of the change request */
  crStatus?: string;

  // ── Inline-action fields (kind === 'timesheet') ───────────────────────────
  /** Monday of the submitted week (period_start) */
  periodStart?: string;
  /** Snapshot hours_total from the submission */
  hoursTotal?: number;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function ageDays(createdAt: string): number {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/** Numeric sort weight — lower = higher priority */
function weight(item: ReviewItem): number {
  const kindWeight: Record<ReviewKind, number> = {
    approval: 0,
    rebaseline: 1,
    timesheet: 1.5, // between 'approval' and 'change' (D per f2b-specs.md T5)
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
): Promise<ReviewItem[]> {
  // Build a project-id → name map for enrichment
  const { data: projectRows } = await db
    .from("projects")
    .select("id, name, code");

  const projectMap = new Map<string, string>(
    (projectRows ?? []).map((p: { id: string; name: string }) => [p.id, p.name]),
  );

  // Build a member-id → name map (for the 'timesheet' kind's title)
  const { data: memberRows } = await db.from("resource_members").select("id, name");
  const memberMap = new Map<string, string>(
    (memberRows ?? []).map((m: { id: string; name: string }) => [m.id, m.name]),
  );

  // Fan out all queries in parallel
  const [
    deletionsResult,
    rebaselinesResult,
    risksResult,
    clashesResult,
    documentsResult,
    changeRequestsResult,
    timesheetsResult,
  ] = await Promise.allSettled([
    // 1. Deletion requests pending approval
    db
      .from("deletion_requests")
      .select("id, target_type, target_id, reason, requested_by_label, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true }),

    // 2. Rebaselines pending sign-off
    db
      .from("rebaselines")
      .select("id, project_id, reason, created_at")
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
          .select("id, title, project_id, status, created_at")
          .in("status", ["raised", "under_review"])
          .order("created_at", { ascending: true });
      } catch {
        return { data: null, error: null };
      }
    })(),

    // 7. Timesheet submissions pending decision (L-31; defensive — table may
    //    not exist yet on an unmigrated environment)
    (async () => {
      try {
        return await db
          .from("timesheet_submissions")
          .select("id, member_id, period_start, hours_total, submitted_by_label, submitted_at")
          .eq("status", "submitted")
          .order("submitted_at", { ascending: true });
      } catch {
        return { data: null, error: null };
      }
    })(),
  ]);

  const items: ReviewItem[] = [];

  // ── Deletions ────────────────────────────────────────────────────────────────
  if (deletionsResult.status === "fulfilled") {
    for (const row of deletionsResult.value.data ?? []) {
      items.push({
        id: row.id,
        kind: "approval",
        title: `Delete ${row.target_type}${row.reason ? ` — ${row.reason}` : ""}`,
        ageDays: ageDays(row.created_at),
        href: "/approvals",
        actionLabel: "Approve / reject",
        // inline-action fields
        targetType: row.target_type,
        targetId: row.target_id,
        requestedByLabel: row.requested_by_label ?? undefined,
        deletionReason: row.reason ?? null,
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
        href: row.project_id ? `/projects/${row.project_id}` : "/projects",
        actionLabel: "Sign off",
      });
    }
  }

  // ── Timesheet submissions (L-31) ────────────────────────────────────────────
  if (timesheetsResult.status === "fulfilled") {
    for (const row of (timesheetsResult.value as {
      data: Array<{
        id: string;
        member_id: string;
        period_start: string;
        hours_total: number | string | null;
        submitted_by_label: string;
        submitted_at: string;
      }> | null;
    }).data ?? []) {
      const memberName = memberMap.get(row.member_id) ?? "Unknown member";
      const hours = typeof row.hours_total === "string" ? Number(row.hours_total) : (row.hours_total ?? 0);
      items.push({
        id: row.id,
        kind: "timesheet",
        title: `Timesheet: ${memberName} · week of ${row.period_start}`,
        ageDays: ageDays(row.submitted_at),
        href: "/timesheets",
        actionLabel: "Decide",
        // inline-action fields
        targetType: "timesheet_submission",
        targetId: row.id,
        requestedByLabel: row.submitted_by_label,
        periodStart: row.period_start,
        hoursTotal: Number.isFinite(hours) ? hours : 0,
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
    for (const row of (changeRequestsResult.value as { data: Array<{ id: string; title: string; project_id: string | null; status: string; created_at: string }> | null }).data ?? []) {
      const projectName = row.project_id ? projectMap.get(row.project_id) : undefined;
      items.push({
        id: row.id,
        kind: "change",
        title: row.title,
        project: projectName,
        ageDays: ageDays(row.created_at),
        href: `/change-control?cr=${row.id}`,
        actionLabel: "Decide",
        // inline-action fields
        crStatus: row.status,
      });
    }
  }

  // Sort by priority weight (ascending = highest priority first)
  items.sort((a, b) => weight(a) - weight(b));

  return items;
}
