import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gatherTimeline } from "./gather";
import { fetchDependenciesForTasks, fetchWorkspaceDependencies, withProjectIds } from "./dependencies";

/**
 * Regression for the Mainline P0: the Network lens read `task_dependencies`
 * filtered by a `project_id` column that does not exist, discarded the error,
 * and said "No task dependencies recorded yet" while the seed held 108 edges.
 *
 * This drives the same three calls the page makes (gatherTimeline, then the
 * dependency read, then project derivation) against a fake with the REAL
 * column set, and checks what the lens would be handed.
 */

type Row = Record<string, unknown>;

const COLUMNS: Record<string, string[]> = {
  task_dependencies: ["id", "workspace_id", "predecessor_id", "successor_id", "type", "lag_days", "created_at"],
};

function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      let rows = tables[table] ?? [];
      let error: { message: string } | null = null;
      let range: [number, number] | null = null;
      const check = (col: string) => {
        const known = COLUMNS[table];
        if (known && !known.includes(col)) error = { message: `column ${table}.${col} does not exist` };
      };
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          check(col);
          if (!error) rows = rows.filter((r) => r[col] === val);
          return builder;
        },
        in(col: string, vals: unknown[]) {
          check(col);
          if (!error) rows = rows.filter((r) => vals.includes(r[col]));
          return builder;
        },
        order() {
          return builder;
        },
        range(a: number, b: number) {
          range = [a, b];
          return builder;
        },
        then(resolve: (v: { data: unknown; error: { message: string } | null }) => unknown) {
          const data = error ? null : range ? rows.slice(range[0], range[1] + 1) : rows;
          return Promise.resolve({ data, error }).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

function seed() {
  const tasks: Row[] = [];
  const deps: Row[] = [];
  for (const [pid, n] of [["pA", 20], ["pB", 20]] as const) {
    for (let i = 0; i < n; i++) {
      tasks.push({
        id: `${pid}-t${i}`,
        workspace_id: "ws1",
        project_id: pid,
        name: `Task ${i}`,
        start_date: "2026-09-01",
        due_date: "2026-10-30",
        status_type: "started",
        completion_pct: 10,
      });
      if (i > 0) {
        deps.push({
          id: `${pid}-d${i}`,
          workspace_id: "ws1",
          predecessor_id: `${pid}-t${i - 1}`,
          successor_id: `${pid}-t${i}`,
          type: "FS",
          lag_days: 0,
        });
      }
    }
  }
  return {
    projects: [
      { id: "pA", workspace_id: "ws1", code: "A", name: "Alpha", rag_status: "green" },
      { id: "pB", workspace_id: "ws1", code: "B", name: "Beta", rag_status: "amber" },
    ],
    tasks,
    task_dependencies: deps,
  };
}

describe("Mainline Network lens data (P0 regression)", () => {
  it("hands the lens every seeded edge, each tied to its project, with both ends drawable", async () => {
    const db = fakeDb(seed());
    const graph = await gatherTimeline(db, "ws1", { today: "2026-10-17" });

    const projectOfTask = new Map<string, string | null>();
    for (const n of graph.nodes) if (n.kind === "task") projectOfTask.set(n.id, n.projectId);

    const res = await fetchWorkspaceDependencies(db, "ws1");
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(38); // 19 per project

    const rows = withProjectIds(res.data, projectOfTask);
    expect(rows.every((r) => r.project_id === "pA" || r.project_id === "pB")).toBe(true);

    // what DependencyLens turns into nodes: endpoints that exist as graph tasks
    const nodeIds = new Set<string>();
    for (const d of rows) {
      if (projectOfTask.has(d.predecessor_id)) nodeIds.add(d.predecessor_id);
      if (projectOfTask.has(d.successor_id)) nodeIds.add(d.successor_id);
    }
    expect(nodeIds.size).toBe(40);
  });

  it("the Journal lens gets its project's edges through the task ids, not project_id", async () => {
    const db = fakeDb(seed());
    const graph = await gatherTimeline(db, "ws1", { today: "2026-10-17" });
    const idsOfA = graph.nodes.filter((n) => n.kind === "task" && n.projectId === "pA").map((n) => n.id);
    const res = await fetchDependenciesForTasks(db, idsOfA);
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(19);
    expect(res.data.every((d) => d.successor_id.startsWith("pA-"))).toBe(true);
  });

  it("the old query shape fails loudly with this schema (so the error must be surfaced, never swallowed)", async () => {
    const db = fakeDb(seed());
    const old = (await db.from("task_dependencies").select("id, project_id").eq("project_id", "pA")) as unknown as {
      data: unknown;
      error: { message: string } | null;
    };
    expect(old.data).toBeNull();
    expect(old.error?.message).toMatch(/project_id does not exist/);
  });
});
