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
  it("queries raised and under_review (a new request is 'raised' and nothing auto-advances it)", async () => {
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

describe("gatherReviewItems — the record beside the decision", () => {
  it("names the deletion target from the request's before snapshot, not just its type", async () => {
    const { db } = fakeDb({
      projects: [{ id: "proj-1", name: "Apollo" }],
      deletion_requests: [
        {
          id: "dr-1",
          target_type: "task",
          target_id: "task-uuid-1",
          reason: "Superseded",
          requested_by_label: "maker (agent)",
          requested_by_type: "token",
          requested_by_id: "tok-1",
          requested_principal_id: "user-other",
          before: { name: "Cutover plan", project_id: "proj-1", status: "started" },
          created_at: daysAgo(2),
        },
      ],
    });
    const [item] = (await gatherReviewItems(db)).filter((i) => i.kind === "approval");
    expect(item.targetName).toBe("Cutover plan");
    expect(item.targetProject).toBe("Apollo");
    expect(item.project).toBe("Apollo");
    expect(item.title).toBe("Delete task: Cutover plan — Superseded");
    // no viewer given -> no verdict is invented
    expect(item.decide).toBeUndefined();
  });

  it("carries the change request's requester and impact into the inspector summary", async () => {
    const { db } = fakeDb({
      projects: [{ id: "proj-1", name: "Apollo" }],
      change_requests: [
        {
          id: "cr-1",
          title: "Add SSO",
          project_id: "proj-1",
          status: "raised",
          reference_id: "CR-7",
          priority: "high",
          category: "scope",
          requested_by_label: "Jo",
          requested_by: "user-jo",
          impact_summary: "Two extra sprints",
          impact_schedule_days: 14,
          impact_cost: 8000,
          description: "Enterprise customers ask for it.",
          raised_at: daysAgo(3),
          target_date: null,
          updated_at: "2026-10-14T01:02:03.456+00:00",
          created_at: daysAgo(3),
        },
      ],
    });
    const [item] = (await gatherReviewItems(db)).filter((i) => i.kind === "change");
    expect(item.change).toMatchObject({
      reference: "CR-7",
      priority: "high",
      category: "scope",
      requestedBy: "Jo",
      impactSummary: "Two extra sprints",
      impactScheduleDays: 14,
      impactCost: 8000,
      updatedAt: "2026-10-14T01:02:03.456+00:00",
    });
  });
});

describe("gatherReviewItems — four-eyes verdict for the signed-in viewer", () => {
  const me = { id: "user-me", role: "manager" };

  it("refuses a deletion raised through the viewer's own token, allows someone else's", async () => {
    const { db } = fakeDb({
      deletion_requests: [
        {
          id: "dr-mine",
          target_type: "task",
          target_id: "t1",
          requested_by_type: "token",
          requested_by_id: "tok-1",
          requested_principal_id: "user-me",
          before: { name: "A" },
          created_at: daysAgo(1),
        },
        {
          id: "dr-theirs",
          target_type: "task",
          target_id: "t2",
          requested_by_type: "user",
          requested_by_id: "user-other",
          requested_principal_id: "user-other",
          before: { name: "B" },
          created_at: daysAgo(1),
        },
      ],
    });
    const items = await gatherReviewItems(db, me);
    const byId = Object.fromEntries(items.map((i) => [i.id, i.decide]));
    // ...but it is theirs to withdraw: the person behind a token may cancel what it raised.
    expect(byId["dr-mine"]).toEqual({ canDecide: false, block: "your_token_raised", canWithdraw: true });
    expect(byId["dr-theirs"]).toEqual({ canDecide: true, block: null, canWithdraw: false });
  });

  it("refuses a change request the viewer raised", async () => {
    const { db } = fakeDb({
      change_requests: [
        { id: "cr-mine", title: "Mine", status: "raised", requested_by: "user-me", created_at: daysAgo(1) },
        { id: "cr-theirs", title: "Theirs", status: "raised", requested_by: "user-other", created_at: daysAgo(1) },
      ],
    });
    const items = await gatherReviewItems(db, me);
    const decide = (id: string) => items.find((i) => i.id === id)?.decide;
    expect(decide("cr-mine")).toMatchObject({ canDecide: false, block: "you_raised" });
    expect(decide("cr-theirs")).toMatchObject({ canDecide: true });
  });

  it("a viewer-role session is told it can view but not decide", async () => {
    const { db } = fakeDb({
      change_requests: [{ id: "cr-1", title: "X", status: "raised", requested_by: "user-other", created_at: daysAgo(1) }],
    });
    const [item] = (await gatherReviewItems(db, { id: "user-me", role: "viewer" })).filter((i) => i.kind === "change");
    expect(item.decide).toMatchObject({ canDecide: false, block: "role_not_permitted" });
  });
});
