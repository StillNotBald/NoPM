import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gatherReviewItems } from "./gather";

type Row = Record<string, unknown>;
type Call = { table: string; ops: Array<[string, unknown[]]> };

/** Chainable, awaitable fake: records every filter, resolves per table. */
function fakeDb(tables: Record<string, Row[]>) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "not", "order"]) {
        chain[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return chain;
        };
      }
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve({ data: tables[table] ?? [], error: null }).then(res, rej);
      return chain;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe("gatherReviewItems — change requests", () => {
  it("queries BOTH raised and under_review (a new request is 'raised' and nothing auto-advances it)", async () => {
    const { db, calls } = fakeDb({});
    await gatherReviewItems(db);
    const q = calls.find((c) => c.table === "change_requests")!;
    expect(q.ops).toContainEqual(["in", ["status", ["raised", "under_review"]]]);
    // the old single-status filter must be gone
    expect(q.ops.filter(([op, args]) => op === "eq" && args[0] === "status")).toEqual([]);
  });

  it("lists a default 'raised' change request in the queue, carrying its status", async () => {
    const { db } = fakeDb({
      projects: [{ id: "proj-1", name: "Apollo" }],
      change_requests: [
        { id: "cr-1", title: "Add SSO", project_id: "proj-1", status: "raised", created_at: daysAgo(3) },
        { id: "cr-2", title: "Move launch", project_id: "proj-1", status: "under_review", created_at: daysAgo(1) },
      ],
    });
    const items = await gatherReviewItems(db);
    const changes = items.filter((i) => i.kind === "change");
    expect(changes.map((c) => [c.id, c.crStatus, c.project])).toEqual([
      ["cr-1", "raised", "Apollo"],
      ["cr-2", "under_review", "Apollo"],
    ]);
    // older first within the kind
    expect(changes[0].ageDays).toBeGreaterThan(changes[1].ageDays);
  });
});
