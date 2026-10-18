import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DECIDE_SCOPES, listPendingApprovals, type ScopeProbe } from "./pending";

type Row = Record<string, unknown>;
type Call = { table: string; ops: Array<[string, unknown[]]> };

/** Chainable, awaitable fake. An `eq("assigned_approver_id", x)` really narrows the rows, like the database would. */
function fakeDb(tables: Record<string, Row[]>) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "or", "order", "limit"]) {
        chain[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return chain;
        };
      }
      chain.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        let rows = tables[table] ?? [];
        for (const [op, args] of call.ops) {
          if (op === "eq" && args[0] === "assigned_approver_id") rows = rows.filter((r) => r.assigned_approver_id === args[1]);
        }
        return Promise.resolve({ data: rows, count: rows.length, error: null }).then(res, rej);
      };
      return chain;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

const allow: ScopeProbe = () => null;
const WS = "ws-1";
const ME = "user-me";
const OTHER = "user-other";
const me = { type: "user" as const, id: ME, workspaceId: WS, principalId: ME };

const change = (id: string, assigned: string | null): Row => ({
  id,
  workspace_id: WS,
  status: "raised",
  title: `CR ${id}`,
  requested_by_type: "user",
  requested_by_id: OTHER,
  requested_principal_id: OTHER,
  raised_at: "2026-10-10T08:00:00+00:00",
  assigned_approver_id: assigned,
});
const rebaseline = (id: string, assigned: string | null): Row => ({
  id,
  workspace_id: WS,
  status: "pending_approval",
  version: 2,
  requested_by: OTHER,
  created_at: "2026-10-11T08:00:00+00:00",
  assigned_approver_id: assigned,
});
const deletion = (id: string, assigned: string | null): Row => ({
  id,
  workspace_id: WS,
  status: "pending",
  target_type: "task",
  target_id: "t1",
  requested_by_type: "user",
  requested_by_id: OTHER,
  before: { name: "A task" },
  created_at: "2026-10-12T08:00:00+00:00",
  assigned_approver_id: assigned,
});

const tables = () => ({
  change_requests: [change("c-mine", ME), change("c-other", OTHER), change("c-nobody", null)],
  rebaselines: [rebaseline("r-mine", ME), rebaseline("r-nobody", null)],
  deletion_requests: [deletion("d-mine", ME), deletion("d-other", OTHER)],
});

describe("listPendingApprovals: assigned approver (G5)", () => {
  it("flags assigned_to_me per item and keeps the whole queue when mine is off", async () => {
    const { db, calls } = fakeDb(tables());
    const out = await listPendingApprovals(db, me, allow);
    expect(out.total).toBe(7);
    const byId = new Map(out.items.map((i) => [i.id, i]));
    expect(byId.get("c-mine")).toMatchObject({ assigned_to_me: true, assigned_approver_id: ME });
    expect(byId.get("c-other")).toMatchObject({ assigned_to_me: false, assigned_approver_id: OTHER });
    expect(byId.get("c-nobody")).toMatchObject({ assigned_to_me: false, assigned_approver_id: null });
    for (const c of calls) expect(c.ops.some(([op, a]) => op === "eq" && a[0] === "assigned_approver_id")).toBe(false);
  });

  it("mine narrows every kind to requests assigned to the caller's person", async () => {
    const { db, calls } = fakeDb(tables());
    const out = await listPendingApprovals(db, me, allow, { mine: true });
    expect(out.items.map((i) => i.id).sort()).toEqual(["c-mine", "d-mine", "r-mine"]);
    expect(out.total).toBe(3);
    expect(out.items.every((i) => i.assigned_to_me)).toBe(true);
    // narrowed in the query (so the total and paging are exact), and still scoped to the workspace
    for (const c of calls.filter((x) => ["change_requests", "rebaselines", "deletion_requests"].includes(x.table))) {
      expect(c.ops).toContainEqual(["eq", ["assigned_approver_id", ME]]);
      expect(c.ops).toContainEqual(["eq", ["workspace_id", WS]]);
    }
  });

  it("matches the person behind a token, not the token id", async () => {
    const { db } = fakeDb(tables());
    const token = { type: "token" as const, id: "tok-1", workspaceId: WS, principalId: ME };
    const out = await listPendingApprovals(db, token, allow, { mine: true });
    expect(out.items.map((i) => i.id).sort()).toEqual(["c-mine", "d-mine", "r-mine"]);
  });

  it("a caller with no resolvable person has nothing assigned: empty, and nothing is queried", async () => {
    const { db, calls } = fakeDb(tables());
    const orphan = { type: "token" as const, id: "tok-2", workspaceId: WS, principalId: null };
    const out = await listPendingApprovals(db, orphan, allow, { mine: true });
    expect(out).toMatchObject({ items: [], total: 0 });
    expect(calls).toHaveLength(0);
    // the same caller without mine still sees the queue, none of it assigned to them
    const all = await listPendingApprovals(fakeDb(tables()).db, orphan, allow);
    expect(all.items.every((i) => !i.assigned_to_me)).toBe(true);
  });

  it("assignment never grants the right to decide", async () => {
    const { db } = fakeDb(tables());
    const noDecide: ScopeProbe = (scope) => ((Object.values(DECIDE_SCOPES) as string[]).includes(scope) ? "missing scope" : null);
    const out = await listPendingApprovals(db, me, noDecide, { mine: true });
    expect(out.items.length).toBe(3);
    expect(out.items.every((i) => i.assigned_to_me && !i.can_decide)).toBe(true);
  });
});
