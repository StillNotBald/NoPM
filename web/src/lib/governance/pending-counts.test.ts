import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getPendingCounts } from "./pending-counts";

type Call = { table: string; ops: Array<[string, unknown[]]> };

/** Chainable, awaitable fake: records filters, resolves with a per-table count. */
function fakeDb(counts: Record<string, number | "error" | "throw">) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "not", "or"]) {
        chain[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return chain;
        };
      }
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        const v = counts[table];
        if (v === "throw") return Promise.reject(new Error("boom")).then(res, rej);
        if (v === "error") return Promise.resolve({ count: null, error: { message: "x" } }).then(res, rej);
        return Promise.resolve({ count: v ?? 0, error: null }).then(res, rej);
      };
      return chain;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const actor = { userId: "user-1", workspaceId: "ws-1" };

describe("getPendingCounts", () => {
  it("sums disjoint buckets and never double-counts", async () => {
    const { db } = fakeDb({
      deletion_requests: 2,
      change_requests: 3,
      decisions: 4,
      rebaselines: 1,
      risks: 5,
      clashes: 1,
      documents: 1,
    });
    const r = await getPendingCounts(db, actor);
    expect(r).toEqual({ approvals: 2, changeControl: 3, decisions: 4, review: 8, total: 17 });
  });

  it("filters every query by workspace", async () => {
    const { db, calls } = fakeDb({});
    await getPendingCounts(db, actor);
    expect(calls).toHaveLength(7);
    for (const c of calls) {
      expect(c.ops).toContainEqual(["eq", ["workspace_id", "ws-1"]]);
    }
  });

  it("excludes the actor's own four-eyes items", async () => {
    const { db, calls } = fakeDb({});
    await getPendingCounts(db, actor);
    const ors = (t: string) => calls.find((c) => c.table === t)!.ops.filter(([o]) => o === "or").map(([, a]) => a[0]);
    expect(ors("deletion_requests")[0]).toContain("requested_by_id.neq.user-1");
    expect(ors("change_requests")[0]).toContain("requested_by.neq.user-1");
    expect(ors("rebaselines")[0]).toContain("requested_by.neq.user-1");
    expect(ors("decisions")).toHaveLength(0);
  });

  it("treats query errors and throws as zero", async () => {
    const { db } = fakeDb({ deletion_requests: "error", documents: "throw", decisions: 2 });
    const r = await getPendingCounts(db, actor);
    expect(r).toEqual({ approvals: 0, changeControl: 0, decisions: 2, review: 0, total: 2 });
  });
});
