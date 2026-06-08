import type { SupabaseClient } from "@supabase/supabase-js";
import { writeAudit } from "@/lib/audit/write";
import type { Actor } from "@/lib/auth/guard";

/**
 * Detect over-allocation for a given member and upsert a clash row if
 * allocation_pct exceeds 100% across any overlapping windows.
 *
 * Called after every allocation POST/PATCH. Audit action: clash.auto_detected.
 */
export async function detectOverAllocation(
  db: SupabaseClient,
  workspaceId: string,
  memberId: string,
  actor: Actor,
): Promise<void> {
  // Fetch the member name for the clash title
  const { data: member } = await db
    .from("resource_members")
    .select("id, name")
    .eq("id", memberId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!member) return;

  // Fetch all allocations for this member, including window info
  const { data: allocations, error } = await db
    .from("allocations")
    .select("id, allocation_pct, window_start, window_end")
    .eq("member_id", memberId)
    .eq("workspace_id", workspaceId);

  if (error || !allocations || allocations.length === 0) return;

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
    // No over-allocation — resolve any existing open clash for this member
    await db
      .from("clashes")
      .update({ status: "resolved" })
      .eq("workspace_id", workspaceId)
      .eq("resource_member_id", memberId)
      .eq("type", "resource")
      .eq("status", "open");
    return;
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

  // Check for an existing open clash for this member
  const { data: existing } = await db
    .from("clashes")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("resource_member_id", memberId)
    .eq("type", "resource")
    .eq("status", "open")
    .maybeSingle();

  if (existing) {
    // Update the existing clash
    const { data: updated, error: updateErr } = await db
      .from("clashes")
      .update({
        title,
        severity,
        window_start: overlapWindowStart,
        window_end: overlapWindowEnd,
        description,
        recommended_action: recommendedAction,
        over_allocation_pct: overAllocationPct,
      })
      .eq("id", existing.id)
      .eq("workspace_id", workspaceId)
      .select()
      .single();

    if (updateErr) throw updateErr;

    await writeAudit({
      workspaceId,
      actor,
      action: "clash.auto_detected",
      targetType: "clash",
      targetId: existing.id,
      before: existing,
      after: updated,
    });
  } else {
    // Insert a new clash
    const { data: inserted, error: insertErr } = await db
      .from("clashes")
      .insert({
        workspace_id: workspaceId,
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
      })
      .select()
      .single();

    if (insertErr) throw insertErr;

    await writeAudit({
      workspaceId,
      actor,
      action: "clash.auto_detected",
      targetType: "clash",
      targetId: inserted.id,
      before: null,
      after: inserted,
    });
  }
}
