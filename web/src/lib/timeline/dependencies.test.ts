import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ID_CHUNK,
  PAGE_SIZE,
  fetchDependenciesForTasks,
  fetchWorkspaceDependencies,
  withProjectIds,
  type DependencyRow,
} from "./dependencies";

// ── a tiny PostgREST-shaped fake ─────────────────────────────────────────────
// Mimics the real table: there is NO project_id column, so a filter on it
// returns an error exactly like production did.

const COLUMNS = new Set(["id", "workspace_id", "predecessor_id", "successor_id", "type", "lag_days", "created_at"]);

interface Row extends DependencyRow {
  workspace_id: string;
}

function fakeDb(rows: Row[], opts: { failOn?: (call: string) => boolean } = {}) {
  const calls: string[] = [];
  const db = {
    from(table: string) {
      expect(table).toBe("task_dependencies");
      let result = rows;
      let error: { message: string } | null = null;
      let range: [number, number] | null = null;
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          calls.push(`eq:${col}`);
          if (!COLUMNS.has(col)) error = { message: `column task_dependencies.${col} does not exist` };
          else result = result.filter((r) => (r as unknown as Record<string, unknown>)[col] === val);
          return builder;
        },
        in(col: string, vals: unknown[]) {
          calls.push(`in:${col}:${vals.length}`);
          if (!COLUMNS.has(col)) error = { message: `column task_dependencies.${col} does not exist` };
          else result = result.filter((r) => vals.includes((r as unknown as Record<string, unknown>)[col]));
          if (opts.failOn?.(`in:${col}`)) error = { message: "boom" };
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
          const data = error ? null : range ? result.slice(range[0], range[1] + 1) : result;
          return Promise.resolve({ data, error }).then(resolve);
        },
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const dep = (id: string, pred: string, succ: string, ws = "ws1"): Row => ({
  id,
  workspace_id: ws,
  predecessor_id: pred,
  successor_id: succ,
  type: "FS",
  lag_days: 0,
});

describe("fetchDependenciesForTasks (Journal lens)", () => {
  it("scopes through the project's task ids and never filters on project_id", async () => {
    const { db, calls } = fakeDb([dep("d1", "t1", "t2"), dep("d2", "t2", "t3"), dep("d3", "x1", "x2")]);
    const res = await fetchDependenciesForTasks(db, ["t1", "t2", "t3"]);
    expect(res.error).toBeNull();
    expect(res.data.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(calls.some((c) => c.includes("project_id"))).toBe(false);
    expect(calls).toEqual(["in:successor_id:3"]);
  });

  it("returns the seed-sized edge set (17 deps for a project of 20 tasks)", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const edges = Array.from({ length: 17 }, (_, i) => dep(`d${i}`, `t${i}`, `t${i + 1}`));
    const { db } = fakeDb(edges);
    const res = await fetchDependenciesForTasks(db, ids);
    expect(res.data).toHaveLength(17);
  });

  it("chunks long id lists and de-duplicates", async () => {
    const ids = Array.from({ length: ID_CHUNK * 2 + 5 }, (_, i) => `t${i}`);
    const { db, calls } = fakeDb([dep("d1", "t0", "t1"), dep("d2", "t150", "t151")]);
    const res = await fetchDependenciesForTasks(db, ids);
    expect(calls).toEqual([`in:successor_id:${ID_CHUNK}`, `in:successor_id:${ID_CHUNK}`, "in:successor_id:5"]);
    expect(res.data.map((d) => d.id).sort()).toEqual(["d1", "d2"]);
  });

  it("makes no request for a project with no tasks", async () => {
    const { db, calls } = fakeDb([dep("d1", "a", "b")]);
    const res = await fetchDependenciesForTasks(db, []);
    expect(res).toEqual({ data: [], error: null });
    expect(calls).toEqual([]);
  });

  it("SURFACES a query error instead of swallowing it into an empty list", async () => {
    const { db } = fakeDb([dep("d1", "t1", "t2")], { failOn: () => true });
    const res = await fetchDependenciesForTasks(db, ["t1", "t2"]);
    expect(res.error).toBe("boom");
    expect(res.data).toEqual([]);
  });
});

describe("fetchWorkspaceDependencies (Network lens)", () => {
  it("reads every edge of the workspace by workspace_id (108 seed edges)", async () => {
    const edges = Array.from({ length: 108 }, (_, i) => dep(`d${i}`, `a${i}`, `b${i}`));
    edges.push(dep("other", "z1", "z2", "ws2"));
    const { db, calls } = fakeDb(edges);
    const res = await fetchWorkspaceDependencies(db, "ws1");
    expect(res.error).toBeNull();
    expect(res.data).toHaveLength(108);
    expect(calls).toEqual(["eq:workspace_id"]);
  });

  it("pages past the PostgREST row cap", async () => {
    const edges = Array.from({ length: PAGE_SIZE + 37 }, (_, i) => dep(`d${i}`, `a${i}`, `b${i}`));
    const { db } = fakeDb(edges);
    const res = await fetchWorkspaceDependencies(db, "ws1");
    expect(res.data).toHaveLength(PAGE_SIZE + 37);
  });

  it("reports the exact failure the old project_id filter caused", async () => {
    // Regression: `.eq("project_id", ...)` -> "column ... does not exist", which the
    // old page discarded, so the Network lens said "No task dependencies recorded".
    const { db } = fakeDb([dep("d1", "a", "b")]);
    const res = await (db.from("task_dependencies") as unknown as {
      select: (c: string) => { eq: (c: string, v: string) => PromiseLike<{ data: unknown; error: { message: string } | null }> };
    })
      .select("id")
      .eq("project_id", "p1");
    expect(res.error?.message).toMatch(/project_id does not exist/);
  });
});

describe("withProjectIds", () => {
  const projectOf = new Map<string, string | null>([
    ["a1", "pA"],
    ["a2", "pA"],
    ["b1", "pB"],
    ["orphan", null],
  ]);

  it("derives the project from the tasks at both ends", () => {
    const out = withProjectIds([dep("d1", "a1", "a2")], projectOf);
    expect(out[0].project_id).toBe("pA");
  });

  it("keeps cross-project and unknown-task edges, with no guessed project", () => {
    const out = withProjectIds([dep("d1", "a1", "b1"), dep("d2", "a1", "ghost"), dep("d3", "orphan", "a1")], projectOf);
    expect(out.map((e) => e.project_id)).toEqual([null, null, null]);
    expect(out).toHaveLength(3);
  });
});
