import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What a project deletion would take with it (red-team R1/M5).
 *
 * Deleting a project cascades to everything that hangs off it. The request used
 * to snapshot only the project ROW, so a project that was empty when the
 * deletion was requested could gain tasks, risks, change requests, time
 * entries... before the approver clicked, and the approval destroyed them all
 * without anyone having been asked about them.
 *
 * The request now records how many rows of each child kind existed
 * (`deletion_requests.before.child_counts`, produced by the SQL function
 * `nopm_project_child_counts` of migration 0049), and the approval refuses
 * (422 `children_changed`) when the counts no longer match: the BEFORE DELETE
 * trigger on projects compares them inside the commit transaction, so the DB is
 * the source of truth and no code path can skip it. The counts also ride into
 * the `project.delete` audit row (it carries `before`), so the record shows what
 * was actually removed.
 *
 * Counting happens in SQL on both sides, so request-time and commit-time numbers
 * cannot disagree about what a "child" is.
 *
 * Counts alone are not a fingerprint: delete one task and add another and every
 * count is unchanged, and renaming the project or moving its dates changes no
 * count at all. Migration 0056 therefore makes the same SQL function also return
 * a reserved `_scope` object ({ project: md5 of the project row's own fields,
 * ids: { <table>: md5 of that table's sorted child ids } }). It rides inside
 * `child_counts` (the build that predates 0056 stores it without knowing), and
 * the trigger compares the whole object when the snapshot has it, counts only
 * when it does not (a legacy snapshot). Every other key is still a plain count.
 */
export const CHILD_COUNTS_KEY = "child_counts";

/** The content fingerprint 0056 adds under the reserved `_scope` key. Opaque to TypeScript; compared in SQL. */
export type ScopeFingerprint = { project: string | null; ids: Record<string, string> };

/** Per-table row counts, plus (from 0056) the `_scope` fingerprint. */
export type ChildCounts = Record<string, number | ScopeFingerprint>;

/** The reserved key of the content fingerprint inside `child_counts` (never a table name). */
export const SCOPE_KEY = "_scope";

/** Just the per-table counts of a snapshot, without the fingerprint (for display). */
export function countsOnly(snapshot: ChildCounts): Record<string, number> {
  return Object.fromEntries(
    Object.entries(snapshot).filter((e): e is [string, number] => e[0] !== SCOPE_KEY && typeof e[1] === "number"),
  );
}

/** Current child-row counts for `projectId`. Fails closed: no snapshot, no request. */
export async function projectChildCounts(db: SupabaseClient, projectId: string): Promise<ChildCounts> {
  const { data, error } = await db.rpc("nopm_project_child_counts", { p_project_id: projectId });
  if (error) throw new Error(`Could not snapshot the project's contents: ${error.message}`);
  return (data ?? {}) as ChildCounts;
}

/**
 * The governed records a project deletion takes with it (D2). Approving the
 * deletion writes one audit row per record of these kinds (migration 0064:
 * `<type>.cascade_delete`), so the approval screen should say how many there are.
 * Keys are the `child_counts` keys; sign-offs hang off rebaselines and are
 * audited with them, so they have no count of their own.
 */
export const GOVERNED_CHILD_KEYS = ["change_requests", "decisions", "documents", "rebaselines"] as const;
export type GovernedChildCounts = Record<(typeof GOVERNED_CHILD_KEYS)[number], number>;

/** `{ change_requests, decisions, documents, rebaselines }` from a snapshot (0 when absent). */
export function governedChildCounts(snapshot: ChildCounts | null | undefined): GovernedChildCounts {
  const counts = countsOnly(snapshot ?? {});
  return Object.fromEntries(GOVERNED_CHILD_KEYS.map((k) => [k, counts[k] ?? 0])) as GovernedChildCounts;
}
