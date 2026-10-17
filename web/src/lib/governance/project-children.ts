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
 */
export const CHILD_COUNTS_KEY = "child_counts";

export type ChildCounts = Record<string, number>;

/** Current child-row counts for `projectId`. Fails closed: no snapshot, no request. */
export async function projectChildCounts(db: SupabaseClient, projectId: string): Promise<ChildCounts> {
  const { data, error } = await db.rpc("nopm_project_child_counts", { p_project_id: projectId });
  if (error) throw new Error(`Could not snapshot the project's contents: ${error.message}`);
  return (data ?? {}) as ChildCounts;
}
