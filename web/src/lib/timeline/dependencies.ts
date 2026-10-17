/**
 * Task-dependency reads for the Mainline lenses.
 *
 * `task_dependencies` has NO `project_id` column (migration 0012: id,
 * workspace_id, predecessor_id, successor_id, type, lag_days, created_at;
 * 20260814000028 says so again). Mainline used to filter on `project_id`, got
 * a PostgREST error, destructured only `data`, and so drew a permanently
 * empty Network lens and a Journal with no arrows. These helpers scope through
 * task ids instead (the idiom projects/[id]/page.tsx uses) and, unlike the old
 * code, RETURN the error so the page can show it.
 *
 * No React, no Next: takes any Supabase-shaped client so it is unit-testable.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface DependencyRow {
  id: string;
  predecessor_id: string;
  successor_id: string;
  type: "FS" | "SS" | "FF" | "SF";
  lag_days: number;
}

export interface DependencyFetch {
  data: DependencyRow[];
  /** First error message encountered, or null. Rows fetched before it are kept. */
  error: string | null;
}

const COLUMNS = "id, predecessor_id, successor_id, type, lag_days";

/**
 * `.in()` puts every id in the request URL. Chunk so a big project cannot
 * exceed the URL limit (36 chars per uuid, ~100 per request = ~4 KB).
 */
export const ID_CHUNK = 100;

/** PostgREST returns at most this many rows per request unless paged. */
export const PAGE_SIZE = 1000;

/**
 * Edges where the SUCCESSOR is one of `taskIds`. An edge usable inside a
 * project needs both ends in the project, so successor-in-set is a superset of
 * everything a project view can draw (cross-project edges are dropped later).
 */
export async function fetchDependenciesForTasks(
  db: SupabaseClient,
  taskIds: readonly string[],
): Promise<DependencyFetch> {
  const out: DependencyRow[] = [];
  const seen = new Set<string>();
  let error: string | null = null;

  for (let i = 0; i < taskIds.length; i += ID_CHUNK) {
    const chunk = taskIds.slice(i, i + ID_CHUNK);
    const { data, error: e } = await db
      .from("task_dependencies")
      .select(COLUMNS)
      .in("successor_id", chunk);
    if (e) {
      error = error ?? e.message;
      continue;
    }
    for (const row of (data ?? []) as unknown as DependencyRow[]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      out.push(row);
    }
  }
  return { data: out, error };
}

/**
 * Every edge in the workspace (the Network lens). `workspace_id` is on the
 * table, so no id list is needed; pages through PostgREST's row cap.
 */
export async function fetchWorkspaceDependencies(
  db: SupabaseClient,
  workspaceId: string,
): Promise<DependencyFetch> {
  const out: DependencyRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from("task_dependencies")
      .select(COLUMNS)
      .eq("workspace_id", workspaceId)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) return { data: out, error: error.message };
    const rows = (data ?? []) as unknown as DependencyRow[];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return { data: out, error: null };
}

/**
 * Attach the owning project to each edge, derived from its tasks (the table
 * has no such column). An edge belongs to a project only when BOTH ends are in
 * it; an edge with an unknown end, or ends in two projects, gets
 * `project_id: null` rather than a guess. It is still returned: the Network
 * lens draws every edge, and only skips null-project edges when it runs the
 * per-project critical-path pass.
 */
export function withProjectIds<T extends DependencyRow>(
  rows: readonly T[],
  projectOfTask: ReadonlyMap<string, string | null>,
): Array<T & { project_id: string | null }> {
  return rows.map((row) => {
    const succ = projectOfTask.get(row.successor_id) ?? null;
    const pred = projectOfTask.get(row.predecessor_id) ?? null;
    return { ...row, project_id: succ && pred && succ === pred ? succ : null };
  });
}
