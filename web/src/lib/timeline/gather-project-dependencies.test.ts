import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gatherTimeline } from "./gather";

type Rows = Record<string, Record<string, unknown>[]>;

function fakeDb(rows: Rows) {
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
          Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve),
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const ms = (id: string, project_id: string, target_date: string) => ({
  id,
  project_id,
  name: id,
  target_date,
  baseline_target_date: null,
  status: "on_track",
  completion_pct: 0,
});

const SEED: Rows = {
  projects: [
    { id: "pa", code: "AAA", name: "Alpha", rag_status: "green" },
    { id: "pb", code: "BBB", name: "Beta", rag_status: "red" },
    { id: "pc", code: "CCC", name: "Gamma", rag_status: "green" },
  ],
  milestones: [ms("a1", "pa", "2026-11-01"), ms("a2", "pa", "2026-12-01"), ms("b1", "pb", "2026-10-20"), ms("b2", "pb", "2026-11-15")],
  project_dependencies: [
    { id: "d1", project_id: "pa", depends_on_project_id: "pb", kind: "delivery", note: "needs the API" },
    // a project with no milestones still shows in the list, only the milestone edge is absent
    { id: "d2", project_id: "pc", depends_on_project_id: "pb", kind: "resource", note: null },
    // a dependency whose project is not in the graph is dropped
    { id: "d3", project_id: "pa", depends_on_project_id: "ghost", kind: "risk", note: null },
  ],
};

describe("gatherTimeline cross-project dependencies (R-147)", () => {
  it("exposes every declared project dependency whose two projects are known", async () => {
    const g = await gatherTimeline(fakeDb(SEED), "ws1", { today: "2026-10-18" });
    expect(g.projectDependencies.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(g.projectDependencies[0]).toEqual({ id: "d1", projectId: "pa", dependsOnProjectId: "pb", kind: "delivery", note: "needs the API" });
  });

  it("draws a dependency edge from the depended-on project's last milestone to the dependent's first", async () => {
    const g = await gatherTimeline(fakeDb(SEED), "ws1", { today: "2026-10-18" });
    const dep = g.edges.filter((e) => e.kind === "dependency");
    expect(dep).toEqual([{ from: "b2", to: "a1", kind: "dependency", critical: false, label: "delivery" }]);
  });

  it("keeps the same-project sequence edges unchanged", async () => {
    const g = await gatherTimeline(fakeDb(SEED), "ws1", { today: "2026-10-18" });
    expect(g.edges.filter((e) => e.kind === "sequence").map((e) => `${e.from}>${e.to}`).sort()).toEqual(["a1>a2", "b1>b2"]);
  });

  it("returns an empty list when no project dependency exists", async () => {
    const g = await gatherTimeline(fakeDb({ projects: SEED.projects, milestones: SEED.milestones }), "ws1", { today: "2026-10-18" });
    expect(g.projectDependencies).toEqual([]);
    expect(g.edges.some((e) => e.kind === "dependency")).toBe(false);
  });
});
