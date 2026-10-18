import type { SupabaseClient } from "@supabase/supabase-js";
import { RuleError } from "@/lib/api/errors";

/** Statuses that mean the clash is still live (everything except resolved). */
export const LIVE_CLASH_STATUSES = ["open", "investigating"] as const;

export function isLiveClashStatus(status: string | null | undefined): boolean {
  return status === "open" || status === "investigating";
}

export function duplicateClashMessage(type: string, existingRef: string | null): string {
  return `This person already has an open ${type} clash${existingRef ? ` (${existingRef})` : ""}. Update that clash instead of adding a second one.`;
}

/**
 * Q-WRK-2 — one open clash per person and type. Throws 422 `duplicate_clash`
 * when another live clash exists for the same resource member and type.
 * `excludeId` is the clash being edited (it is not a duplicate of itself).
 * Clashes without a person (project-vs-project) are not subject to the rule.
 */
export async function assertNoDuplicateLiveClash(
  db: SupabaseClient,
  workspaceId: string,
  clash: { resource_member_id?: string | null; type: string; status?: string | null },
  excludeId?: string,
): Promise<void> {
  if (!clash.resource_member_id) return;
  if (!isLiveClashStatus(clash.status ?? "open")) return;
  const { data, error } = await db
    .from("clashes")
    .select("id, reference_id")
    .eq("workspace_id", workspaceId)
    .eq("resource_member_id", clash.resource_member_id)
    .eq("type", clash.type)
    .in("status", [...LIVE_CLASH_STATUSES]);
  if (error) throw error;
  const other = ((data ?? []) as { id: string; reference_id?: string | null }[]).find((c) => c.id !== excludeId);
  if (other) {
    throw new RuleError(duplicateClashMessage(clash.type, other.reference_id ?? null), "duplicate_clash");
  }
}
