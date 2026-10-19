import type { SupabaseClient } from "@supabase/supabase-js";
import { auditedInsert, auditedUpdate } from "@/lib/audit/audited-write";
import { buildRpcAudit } from "@/lib/audit/sql-audit-insert";
import type { Actor } from "@/lib/auth/guard";

/** Clash statuses that mean "still live" (everything except resolved). */
const LIVE_CLASH_STATUSES = ["open", "investigating"];

/**
 * Detect over-allocation for a given member and upsert a clash row if
 * allocation_pct exceeds 100% across any overlapping windows.
 *
 * Called after every allocation POST/PATCH. Audit action: clash.auto_detected.
 *
 * Atomic (R-165): create and update-existing go through the generic nopm_mutate_audited wrapper on
 * `clashes`, auto-resolve through nopm_clash_auto_resolve. Each audit row is written in the same
 * transaction as its change, with the caller whose allocation write triggered detection as the actor.
 */
/**
 * Returns true when an over-allocation clash was detected (new or existing),
 * false when allocation is within limits (clash resolved or no clash).
 */
export async function detectOverAllocation(
  db: SupabaseClient,
  workspaceId: string,
  memberId: string,
  actor: Actor,
  retried = false,
): Promise<boolean> {
  // Fetch the member name for the clash title
  const { data: member } = await db
    .from("resource_members")
    .select("id, name")
    .eq("id", memberId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!member) return false;

  // Fetch all allocations for this member, including window info
  const { data: allocations, error } = await db
    .from("allocations")
    .select("id, allocation_pct, window_start, window_end")
    .eq("member_id", memberId)
    .eq("workspace_id", workspaceId);

  if (error || !allocations || allocations.length === 0) return false;

  // Find overlapping groups. For each allocation, check if it overlaps with
  // any other and accumulate pct. Use a simple sweep: collect all unique
  // (start, end) pairs and for each pair sum pct of all allocations that
  // overlap that window.
  //
  // Simplified approach: collect all allocations that have a window and group
  // by overlap. If any two allocations' windows overlap, sum their pcts.
  // If any group exceeds 100, raise/upsert a clash.

  let maxPct = 0;
  let overlapWindowStart: string | null = null;
  let overlapWindowEnd: string | null = null;

  // We compare every pair of allocations to find overlapping windows.
  // For small sets (members rarely have > 20 active allocations) this is fine.
  for (let i = 0; i < allocations.length; i++) {
    const a = allocations[i];
    // Accumulate total pct for all allocations overlapping with allocation i
    let groupPct = 0;
    let groupStart: string | null = a.window_start ?? null;
    let groupEnd: string | null = a.window_end ?? null;

    for (const b of allocations) {
      // Two windows overlap if start_a < end_b AND start_b < end_a.
      // Treat null windows as always-overlapping (open-ended).
      const aStart = a.window_start ? new Date(a.window_start) : null;
      const aEnd = a.window_end ? new Date(a.window_end) : null;
      const bStart = b.window_start ? new Date(b.window_start) : null;
      const bEnd = b.window_end ? new Date(b.window_end) : null;

      const overlaps =
        (aStart === null || bEnd === null || aStart < bEnd) &&
        (bStart === null || aEnd === null || bStart < aEnd);

      if (overlaps) {
        groupPct += b.allocation_pct ?? 0;
        // Track the tightest overlapping window for the clash record
        if (b.window_start && (!groupStart || b.window_start > groupStart)) {
          groupStart = b.window_start;
        }
        if (b.window_end && (!groupEnd || b.window_end < groupEnd)) {
          groupEnd = b.window_end;
        }
      }
    }

    if (groupPct > maxPct) {
      maxPct = groupPct;
      overlapWindowStart = groupStart;
      overlapWindowEnd = groupEnd;
    }
  }

  if (maxPct <= 100) {
    // No over-allocation — resolve every still-live (open or investigating)
    // clash for this member, one audit row per resolved clash (the caller whose
    // write triggered detection is the actor).
    const { data: live, error: liveErr } = await db
      .from("clashes")
      .select("*")
      .eq("workspace_id", workspaceId)
      .eq("resource_member_id", memberId)
      .eq("type", "resource")
      .in("status", LIVE_CLASH_STATUSES);
    if (liveErr) throw liveErr;
    for (const clash of (live ?? []) as { id: string }[]) {
      // The status guard lives in SQL: when someone else resolved the clash first the RPC returns null and
      // writes no audit row (no double audit).
      const { error: resolveErr } = await db.rpc("nopm_clash_auto_resolve", {
        p_workspace_id: workspaceId,
        p_clash_id: clash.id,
        p_audit: buildRpcAudit(actor, "clash.auto_resolve", "clash"),
      });
      if (resolveErr) throw resolveErr;
    }
    return false;
  }

  // Determine severity by how far over 100% we are
  const overBy = maxPct - 100;
  const severity =
    overBy >= 100
      ? "critical"
      : overBy >= 50
        ? "high"
        : overBy >= 20
          ? "medium"
          : "low";

  const title = `Over-allocation: ${member.name}`;

  const overAllocationPct = Math.round((maxPct - 100) * 100) / 100;

  const description = `${member.name} is allocated at ${maxPct.toFixed(0)}% capacity (${overAllocationPct.toFixed(0)}% over the 100% limit) during the detected overlap window.`;

  const recommendedAction =
    overAllocationPct >= 100
      ? `Immediately redistribute or defer work for ${member.name}. Consider reassigning tasks to another resource or splitting the allocation across the overlap window.`
      : overAllocationPct >= 50
        ? `Review and reduce allocations for ${member.name}. Negotiate timeline adjustments or partial task handoffs to bring capacity within limits.`
        : overAllocationPct >= 20
          ? `Monitor ${member.name}'s schedule closely. Adjust lower-priority task windows or reduce allocation percentages on overlapping assignments.`
          : `Minor over-allocation detected for ${member.name}. Review allocation windows and consider trimming low-priority commitments.`;

  // Check for an existing live clash for this member. "investigating" counts
  // as open: someone is already working it, so do not raise a second one.
  const { data: existing } = await db
    .from("clashes")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("resource_member_id", memberId)
    .eq("type", "resource")
    .in("status", LIVE_CLASH_STATUSES)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (existing) {
    // Update the existing clash, audited in the same transaction.
    await auditedUpdate({
      table: "clashes",
      actor,
      workspaceId,
      id: existing.id,
      patch: {
        title,
        severity,
        window_start: overlapWindowStart,
        window_end: overlapWindowEnd,
        description,
        recommended_action: recommendedAction,
        over_allocation_pct: overAllocationPct,
      },
      action: "clash.auto_detected",
      targetType: "clash",
    });
  } else {
    // Insert a new clash, audited in the same transaction.
    try {
      await auditedInsert({
        table: "clashes",
        actor,
        workspaceId,
        patch: {
          title,
          type: "resource",
          severity,
          resource_member_id: memberId,
          window_start: overlapWindowStart,
          window_end: overlapWindowEnd,
          status: "open",
          description,
          recommended_action: recommendedAction,
          over_allocation_pct: overAllocationPct,
        },
        action: "clash.auto_detected",
        targetType: "clash",
      });
    } catch (insertErr) {
      // Two detections racing: the partial unique index (migration 0080, one live resource clash per
      // person) refuses the second insert, and the whole transaction (clash and audit row) rolls back.
      // Run once more so it finds the winner and updates it instead.
      if ((insertErr as { code?: string } | null)?.code === "23505" && !retried) {
        return detectOverAllocation(db, workspaceId, memberId, actor, true);
      }
      throw insertErr;
    }
  }

  return true;
}

/**
 * Fail-soft wrapper for the allocation routes: the allocation is already
 * saved (and audited) when detection runs, so a detector failure must not turn
 * a successful write into a 500 that invites a duplicating retry. Logs the
 * error and reports a warning for the response instead.
 */
export async function detectOverAllocationSafe(
  db: SupabaseClient,
  workspaceId: string,
  memberId: string,
  actor: Actor,
): Promise<{ detected: boolean; warning: string | null }> {
  try {
    return { detected: await detectOverAllocation(db, workspaceId, memberId, actor), warning: null };
  } catch (err) {
    console.error("clash detection failed", { workspaceId, memberId, message: (err as Error)?.message });
    return {
      detected: false,
      warning: "The allocation was saved, but over-allocation detection failed; clashes for this member may be out of date.",
    };
  }
}
