import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gatherTimeline } from "./gather";

type Rows = Record<string, Record<string, unknown>[]>;

/** PostgREST-shaped fake: from(t).select(cols).eq(col, v) -> { data, error }. */
function fakeDb(rows: Rows, failing: string[] = []) {
  return {
    from(table: string) {
      const builder = {
        select() {
          return builder;
        },
        eq() {
          return builder;
        },
        then(resolve: (v: { data: unknown; error: { message: string } | null }) => unknown) {
          const error = failing.includes(table) ? { message: `${table} unavailable` } : null;
          return Promise.resolve({ data: error ? null : (rows[table] ?? []), error }).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const SEED: Rows = {
  projects: [{ id: "p1", code: "ALPHA", name: "Alpha", rag_status: "green" }],
  milestones: [
    { id: "m1", project_id: "p1", name: "Go-live", target_date: "2026-12-15", baseline_target_date: null, status: "on_track", completion_pct: 10 },
  ],
  tasks: [
    { id: "t1", project_id: "p1", name: "Build", start_date: "2026-09-01", due_date: "2026-11-01", status_type: "started", completion_pct: 40 },
  ],
};

describe("gatherTimeline today", () => {
  it("uses the injected date for axis.today (Mainline's Today marker)", async () => {
    const graph = await gatherTimeline(fakeDb(SEED), "ws1", { today: "2026-10-17" });
    expect(graph.axis.today).toBe("2026-10-17");
  });

  it("defaults to the real current date, never the old hard-coded demo date", async () => {
    const before = new Date();
    const graph = await gatherTimeline(fakeDb(SEED), "ws1");
    const after = new Date();
    expect(graph.axis.today).not.toBe("2026-06-09");
    // allow the (unlikely) midnight rollover between the two clock reads
    const ok = [before, after].map((d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    );
    expect(ok).toContain(graph.axis.today);
  });

  it("widens the axis to include a today outside the data", async () => {
    const graph = await gatherTimeline(fakeDb(SEED), "ws1", { today: "2027-03-01" });
    expect(graph.axis.end >= "2027-03-01").toBe(true);
    const early = await gatherTimeline(fakeDb(SEED), "ws1", { today: "2026-01-10" });
    expect(early.axis.start <= "2026-01-10").toBe(true);
  });

  it("lays SteerCo gates relative to the injected date's range, not a frozen one", async () => {
    const a = await gatherTimeline(fakeDb(SEED), "ws1", { today: "2026-10-17" });
    const b = await gatherTimeline(fakeDb(SEED), "ws1", { today: "2028-10-17" });
    expect(b.axis.steercoDates.length).toBeGreaterThan(a.axis.steercoDates.length);
  });
});

describe("gatherTimeline errors", () => {
  it("reports each failed table to onError instead of swallowing it", async () => {
    const seen: Array<[string, string]> = [];
    const graph = await gatherTimeline(fakeDb(SEED, ["risks", "clashes"]), "ws1", {
      today: "2026-10-17",
      onError: (t, m) => seen.push([t, m]),
    });
    expect(seen).toEqual([
      ["risks", "risks unavailable"],
      ["clashes", "clashes unavailable"],
    ]);
    // the rest of the graph is still assembled
    expect(graph.projects).toHaveLength(1);
  });

  it("stays backwards compatible: no onError, failures read as empty (API behaviour)", async () => {
    const graph = await gatherTimeline(fakeDb(SEED, ["tasks"]), "ws1", { today: "2026-10-17" });
    expect(graph.counts.task ?? 0).toBe(0);
    expect(graph.counts.milestone).toBe(1);
  });
});
