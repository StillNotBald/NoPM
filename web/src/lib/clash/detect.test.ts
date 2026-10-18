/**
 * detectOverAllocation tests — the auto-clash engine behind every allocation
 * POST/PATCH.
 *
 * Invariants under test:
 *  - only allocations whose windows OVERLAP are summed (a member booked 60% in
 *    Q1 and 60% in Q2 is not over-allocated)
 *  - exactly 100% is fine; >100% raises a clash
 *  - an existing open clash is UPDATED (not duplicated), and either path writes
 *    exactly one `clash.auto_detected` audit row
 *  - dropping back to <=100% resolves the open clash
 *  - the member/workspace filters keep members isolated from each other
 *
 * No live DB — the Supabase client is a hand-rolled chainable stub and
 * @/lib/audit/write is mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Actor } from "@/lib/auth/guard";

const { writeAudit } = vi.hoisted(() => ({
  writeAudit: vi.fn<(input: Record<string, unknown>) => Promise<void>>(async () => {}),
}));
vi.mock("@/lib/audit/write", () => ({ writeAudit }));

import { detectOverAllocation, detectOverAllocationSafe } from "./detect";

const WS = "ws-1";

function actor(): Actor {
  return { type: "user", id: "usr_1", label: "Alice PM", workspaceId: WS };
}

type Alloc = {
  id: string;
  allocation_pct: number | null;
  window_start: string | null;
  window_end: string | null;
};

type Call = { op: string; args: unknown[] };
type Query = { table: string; calls: Call[]; many: boolean };

type DbConfig = {
  members?: Record<string, { id: string; name: string }>;
  allocations?: Record<string, Alloc[]>;
  allocationsError?: { message: string } | null;
  existingClash?: Record<string, unknown> | null;
  /** Live (open/investigating) clashes returned by the resolve-path list read. */
  liveClashes?: Record<string, unknown>[];
  insertError?: { message: string } | null;
  updateError?: { message: string } | null;
};

/**
 * Chainable, thenable query stub in the shape supabase-js returns:
 * every filter/verb returns `this`, and awaiting the builder (or calling
 * .single()/.maybeSingle()) resolves the routed result.
 */
class FakeQuery {
  calls: Call[] = [];
  constructor(
    readonly table: string,
    private readonly route: (q: Query) => { data: unknown; error: unknown },
  ) {}

  private push(op: string, ...args: unknown[]) {
    this.calls.push({ op, args });
    return this;
  }
  select(...a: unknown[]) { return this.push("select", ...a); }
  insert(...a: unknown[]) { return this.push("insert", ...a); }
  update(...a: unknown[]) { return this.push("update", ...a); }
  eq(...a: unknown[]) { return this.push("eq", ...a); }
  in(...a: unknown[]) { return this.push("in", ...a); }
  order(...a: unknown[]) { return this.push("order", ...a); }
  limit(...a: unknown[]) { return this.push("limit", ...a); }
  single() { return Promise.resolve(this.result(false)); }
  maybeSingle() { return Promise.resolve(this.result(false)); }
  then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
    return Promise.resolve(this.result(true)).then(res, rej);
  }
  private result(many: boolean) {
    return this.route({ table: this.table, calls: this.calls, many });
  }
}

function makeDb(cfg: DbConfig) {
  const queries: FakeQuery[] = [];

  /** Value of the first .eq(column, …) filter, used to route per-member data. */
  const eqArg = (q: Query, column: string) =>
    q.calls.find((c) => c.op === "eq" && c.args[0] === column)?.args[1] as string | undefined;
  const hasOp = (q: Query, op: string) => q.calls.some((c) => c.op === op);

  const route = (q: Query): { data: unknown; error: unknown } => {
    if (q.table === "resource_members") {
      const id = eqArg(q, "id") ?? "";
      return { data: cfg.members?.[id] ?? null, error: null };
    }
    if (q.table === "allocations") {
      if (cfg.allocationsError) return { data: null, error: cfg.allocationsError };
      const memberId = eqArg(q, "member_id") ?? "";
      return { data: cfg.allocations?.[memberId] ?? [], error: null };
    }
    if (q.table === "clashes") {
      if (hasOp(q, "insert")) {
        return cfg.insertError
          ? { data: null, error: cfg.insertError }
          : { data: { id: "clash_new", ...(q.calls[0].args[0] as object) }, error: null };
      }
      if (hasOp(q, "update")) {
        if (hasOp(q, "in") && eqArg(q, "id")) {
          // resolve path: per-clash update by id
          return { data: { id: eqArg(q, "id"), status: "resolved" }, error: null };
        }
        return cfg.updateError
          ? { data: null, error: cfg.updateError }
          : { data: { id: "clash_existing", ...(q.calls[0].args[0] as object) }, error: null };
      }
      if (q.many) return { data: cfg.liveClashes ?? [], error: null };
      return { data: cfg.existingClash ?? null, error: null };
    }
    throw new Error(`FakeDb: unexpected table "${q.table}"`);
  };

  const from = vi.fn((table: string) => {
    const q = new FakeQuery(table, route);
    queries.push(q);
    return q;
  });

  return {
    from,
    queries,
    client: { from } as unknown as SupabaseClient,
    /** All queries against a table. */
    on: (table: string) => queries.filter((q) => q.table === table),
    /** The payload passed to the first insert()/update() on a table. */
    payload: (table: string, op: "insert" | "update") => {
      for (const q of queries.filter((x) => x.table === table)) {
        const c = q.calls.find((x) => x.op === op);
        if (c) return c.args[0] as Record<string, unknown>;
      }
      return undefined;
    },
  };
}

const MEMBERS = { m1: { id: "m1", name: "Priya Raman" }, m2: { id: "m2", name: "Sam Ortiz" } };

function alloc(id: string, pct: number, start: string | null, end: string | null): Alloc {
  return { id, allocation_pct: pct, window_start: start, window_end: end };
}

beforeEach(() => {
  writeAudit.mockClear();
});

// ---------------------------------------------------------------------------
// Early exits
// ---------------------------------------------------------------------------
describe("detectOverAllocation — early exits", () => {
  it("returns false and stops when the member does not exist in the workspace", async () => {
    const db = makeDb({ members: {} });
    await expect(detectOverAllocation(db.client, WS, "ghost", actor())).resolves.toBe(false);
    expect(db.on("allocations")).toHaveLength(0);
    expect(db.on("clashes")).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("scopes the member lookup by both id and workspace_id", async () => {
    const db = makeDb({ members: MEMBERS, allocations: { m1: [] } });
    await detectOverAllocation(db.client, WS, "m1", actor());
    const q = db.on("resource_members")[0];
    expect(q.calls.filter((c) => c.op === "eq").map((c) => c.args)).toEqual([
      ["id", "m1"],
      ["workspace_id", WS],
    ]);
  });

  it("returns false when the allocations read errors, without touching clashes", async () => {
    const db = makeDb({
      members: MEMBERS,
      allocationsError: { message: "connection reset" },
    });
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).resolves.toBe(false);
    expect(db.on("clashes")).toHaveLength(0);
  });

  it("returns false when the member has no allocations — and does NOT resolve an open clash (see report)", async () => {
    // Actual behavior: the zero-allocation early return happens BEFORE the
    // resolve path, so deleting a member's last allocation leaves any existing
    // open clash open. Pinned here as-is.
    const db = makeDb({ members: MEMBERS, allocations: { m1: [] } });
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).resolves.toBe(false);
    expect(db.on("clashes")).toHaveLength(0);
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Overlap arithmetic
// ---------------------------------------------------------------------------
describe("detectOverAllocation — overlap arithmetic", () => {
  it("does not clash on non-overlapping windows that would sum over 100%", async () => {
    const db = makeDb({
      members: MEMBERS,
      allocations: {
        m1: [
          alloc("a1", 60, "2026-01-01", "2026-02-01"),
          alloc("a2", 60, "2026-03-01", "2026-04-01"),
        ],
      },
    });
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).resolves.toBe(false);
    expect(db.payload("clashes", "insert")).toBeUndefined();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("does not clash when overlapping windows sum to exactly 100% (boundary)", async () => {
    const db = makeDb({
      members: MEMBERS,
      allocations: {
        m1: [
          alloc("a1", 50, "2026-01-01", "2026-06-01"),
          alloc("a2", 50, "2026-02-01", "2026-05-01"),
        ],
      },
    });
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).resolves.toBe(false);
    expect(db.payload("clashes", "insert")).toBeUndefined();
  });

  it("clashes when overlapping windows exceed 100%", async () => {
    const db = makeDb({
      members: MEMBERS,
      allocations: {
        m1: [
          alloc("a1", 60, "2026-01-01", "2026-06-01"),
          alloc("a2", 60, "2026-02-01", "2026-05-01"),
        ],
      },
    });
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).resolves.toBe(true);
  });

  it("treats null windows as open-ended and therefore always overlapping", async () => {
    const db = makeDb({
      members: MEMBERS,
      allocations: {
        m1: [alloc("a1", 80, null, null), alloc("a2", 40, "2026-01-01", "2026-02-01")],
      },
    });
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).resolves.toBe(true);
    expect(db.payload("clashes", "insert")?.over_allocation_pct).toBe(20);
  });

  it("treats abutting windows (end === next start) as non-overlapping", async () => {
    const db = makeDb({
      members: MEMBERS,
      allocations: {
        m1: [
          alloc("a1", 100, "2026-01-01", "2026-02-01"),
          alloc("a2", 100, "2026-02-01", "2026-03-01"),
        ],
      },
    });
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).resolves.toBe(false);
  });

  it("treats a null allocation_pct as 0", async () => {
    const db = makeDb({
      members: MEMBERS,
      allocations: {
        m1: [
          alloc("a1", 100, "2026-01-01", "2026-06-01"),
          { id: "a2", allocation_pct: null, window_start: "2026-01-01", window_end: "2026-06-01" },
        ],
      },
    });
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).resolves.toBe(false);
  });

  it("over-counts allocations that overlap a wide anchor but not each other (known false positive — see report)", async () => {
    // 10% all year + 60% in Jan + 60% in Nov. Peak concurrent load is 70%, but
    // the anchor-pairwise sum credits both 60% blocks to the year-long booking
    // and reports 130%. Pinned as actual behavior, not endorsed.
    const db = makeDb({
      members: MEMBERS,
      allocations: {
        m1: [
          alloc("a1", 10, "2026-01-01", "2026-12-31"),
          alloc("a2", 60, "2026-01-01", "2026-02-01"),
          alloc("a3", 60, "2026-11-01", "2026-12-01"),
        ],
      },
    });
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).resolves.toBe(true);

    const payload = db.payload("clashes", "insert");
    expect(payload?.over_allocation_pct).toBe(30);
    // ...and the reported window is inverted (start after end), a visible
    // symptom of the same grouping flaw.
    expect(payload?.window_start).toBe("2026-11-01");
    expect(payload?.window_end).toBe("2026-02-01");
  });

  it("records the tightest overlap window on the clash", async () => {
    const db = makeDb({
      members: MEMBERS,
      allocations: {
        m1: [
          alloc("a1", 70, "2026-01-01", "2026-06-01"),
          alloc("a2", 70, "2026-02-15", "2026-04-30"),
        ],
      },
    });
    await detectOverAllocation(db.client, WS, "m1", actor());
    const payload = db.payload("clashes", "insert");
    expect(payload?.window_start).toBe("2026-02-15");
    expect(payload?.window_end).toBe("2026-04-30");
  });
});

// ---------------------------------------------------------------------------
// Severity ladder
// ---------------------------------------------------------------------------
describe("detectOverAllocation — severity ladder", () => {
  it.each([
    [55, 55, "low", 10],
    [70, 60, "medium", 30],
    [100, 60, "high", 60],
    [150, 100, "critical", 150],
  ])("%i%% + %i%% overlapping → %s", async (pctA, pctB, severity, over) => {
    const db = makeDb({
      members: MEMBERS,
      allocations: {
        m1: [
          alloc("a1", pctA, "2026-01-01", "2026-06-01"),
          alloc("a2", pctB, "2026-01-01", "2026-06-01"),
        ],
      },
    });
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).resolves.toBe(true);
    const payload = db.payload("clashes", "insert");
    expect(payload?.severity).toBe(severity);
    expect(payload?.over_allocation_pct).toBe(over);
  });
});

// ---------------------------------------------------------------------------
// Insert path
// ---------------------------------------------------------------------------
describe("detectOverAllocation — new clash insert", () => {
  const overAllocated = {
    members: MEMBERS,
    allocations: {
      m1: [
        alloc("a1", 80, "2026-01-01", "2026-06-01"),
        alloc("a2", 60, "2026-01-01", "2026-06-01"),
      ],
    },
    existingClash: null,
  };

  it("inserts an open resource clash carrying the member, title and guidance", async () => {
    const db = makeDb(overAllocated);
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).resolves.toBe(true);

    const payload = db.payload("clashes", "insert");
    expect(payload).toMatchObject({
      workspace_id: WS,
      type: "resource",
      status: "open",
      resource_member_id: "m1",
      title: "Over-allocation: Priya Raman",
      severity: "medium",
      over_allocation_pct: 40,
    });
    expect(payload?.description).toContain("140%");
    expect(payload?.description).toContain("Priya Raman");
    expect(String(payload?.recommended_action)).toContain("Priya Raman");
  });

  it("writes exactly one clash.auto_detected audit row with before: null", async () => {
    const db = makeDb(overAllocated);
    await detectOverAllocation(db.client, WS, "m1", actor());

    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WS,
        action: "clash.auto_detected",
        targetType: "clash",
        targetId: "clash_new",
        before: null,
      }),
    );
    const call = writeAudit.mock.calls[0][0] as { after: unknown };
    expect(call.after).toMatchObject({ id: "clash_new", status: "open" });
  });

  it("propagates an insert failure instead of silently skipping the clash", async () => {
    const db = makeDb({ ...overAllocated, insertError: { message: "unique violation" } });
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).rejects.toMatchObject({
      message: "unique violation",
    });
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Update path
// ---------------------------------------------------------------------------
describe("detectOverAllocation — existing open clash", () => {
  const existing = { id: "clash_existing", severity: "low", status: "open", title: "old title" };
  const cfg = {
    members: MEMBERS,
    allocations: {
      m1: [
        alloc("a1", 120, "2026-01-01", "2026-06-01"),
        alloc("a2", 60, "2026-01-01", "2026-06-01"),
      ],
    },
    existingClash: existing,
  };

  it("updates the existing clash rather than inserting a duplicate", async () => {
    const db = makeDb(cfg);
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).resolves.toBe(true);

    expect(db.payload("clashes", "insert")).toBeUndefined();
    expect(db.payload("clashes", "update")).toMatchObject({
      title: "Over-allocation: Priya Raman",
      severity: "high",
      over_allocation_pct: 80,
    });
  });

  it("looks the existing clash up by workspace + member + type + live (open/investigating) status", async () => {
    const db = makeDb(cfg);
    await detectOverAllocation(db.client, WS, "m1", actor());
    const lookup = db.on("clashes")[0];
    expect(lookup.calls.filter((c) => c.op === "eq").map((c) => c.args)).toEqual([
      ["workspace_id", WS],
      ["resource_member_id", "m1"],
      ["type", "resource"],
    ]);
    expect(lookup.calls.find((c) => c.op === "in")?.args).toEqual(["status", ["open", "investigating"]]);
  });

  it("audits the update with the previous row as `before`", async () => {
    const db = makeDb(cfg);
    await detectOverAllocation(db.client, WS, "m1", actor());

    expect(writeAudit).toHaveBeenCalledTimes(1);
    const call = writeAudit.mock.calls[0][0] as { before: unknown; targetId: string };
    expect(call.before).toEqual(existing);
    expect(call.targetId).toBe("clash_existing");
  });

  it("propagates an update failure", async () => {
    const db = makeDb({ ...cfg, updateError: { message: "row locked" } });
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).rejects.toMatchObject({
      message: "row locked",
    });
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Resolution path
// ---------------------------------------------------------------------------
describe("detectOverAllocation — resolution when allocation drops back under the limit", () => {
  const UNDER = {
    members: MEMBERS,
    allocations: {
      m1: [alloc("a1", 40, "2026-01-01", "2026-06-01"), alloc("a2", 30, "2026-01-01", "2026-06-01")],
    },
  };

  it("resolves every live (open or investigating) clash for the member and returns false", async () => {
    const db = makeDb({
      ...UNDER,
      liveClashes: [
        { id: "c1", status: "open" },
        { id: "c2", status: "investigating" },
      ],
    });
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).resolves.toBe(false);

    const list = db.on("clashes")[0];
    expect(list.calls.filter((c) => c.op === "eq").map((c) => c.args)).toEqual([
      ["workspace_id", WS],
      ["resource_member_id", "m1"],
      ["type", "resource"],
    ]);
    expect(list.calls.find((c) => c.op === "in")?.args).toEqual(["status", ["open", "investigating"]]);
    const updates = db.on("clashes").filter((q) => q.calls.some((c) => c.op === "update"));
    expect(updates).toHaveLength(2);
    expect(updates[0].calls.find((c) => c.op === "update")?.args[0]).toEqual({ status: "resolved" });
    expect(updates.map((q) => q.calls.find((c) => c.op === "eq" && c.args[0] === "id")?.args[1])).toEqual(["c1", "c2"]);
  });

  it("writes exactly one clash.auto_resolve audit row per resolved clash, by the triggering actor", async () => {
    const db = makeDb({ ...UNDER, liveClashes: [{ id: "c1", status: "open" }, { id: "c2", status: "investigating" }] });
    await detectOverAllocation(db.client, WS, "m1", actor());
    expect(writeAudit).toHaveBeenCalledTimes(2);
    const calls = writeAudit.mock.calls.map((c) => c[0]);
    expect(calls.map((c) => c.action)).toEqual(["clash.auto_resolve", "clash.auto_resolve"]);
    expect(calls.map((c) => c.targetId)).toEqual(["c1", "c2"]);
    expect(calls[0]).toMatchObject({ workspaceId: WS, actor: actor(), targetType: "clash", before: { id: "c1", status: "open" }, after: { status: "resolved" } });
  });

  it("writes no audit row when there is no live clash to resolve", async () => {
    const db = makeDb({ ...UNDER, liveClashes: [] });
    await detectOverAllocation(db.client, WS, "m1", actor());
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Member isolation
// ---------------------------------------------------------------------------
describe("detectOverAllocation — members are isolated from each other", () => {
  const db = () =>
    makeDb({
      members: MEMBERS,
      allocations: {
        m1: [
          alloc("a1", 90, "2026-01-01", "2026-06-01"),
          alloc("a2", 90, "2026-01-01", "2026-06-01"),
        ],
        m2: [
          alloc("b1", 40, "2026-01-01", "2026-06-01"),
          alloc("b2", 30, "2026-01-01", "2026-06-01"),
        ],
      },
    });

  it("clashes for the over-allocated member only", async () => {
    const over = db();
    await expect(detectOverAllocation(over.client, WS, "m1", actor())).resolves.toBe(true);
    expect(over.payload("clashes", "insert")?.title).toBe("Over-allocation: Priya Raman");

    const under = db();
    await expect(detectOverAllocation(under.client, WS, "m2", actor())).resolves.toBe(false);
    expect(under.payload("clashes", "insert")).toBeUndefined();
  });

  it("filters allocations by member_id AND workspace_id so another member's bookings never sum in", async () => {
    const d = db();
    await detectOverAllocation(d.client, WS, "m2", actor());
    const q = d.on("allocations")[0];
    expect(q.calls.filter((c) => c.op === "eq").map((c) => c.args)).toEqual([
      ["member_id", "m2"],
      ["workspace_id", WS],
    ]);
  });
});

describe("detectOverAllocation — an investigating clash counts as open", () => {
  it("updates the investigating clash instead of raising a second one", async () => {
    const db = makeDb({
      members: MEMBERS,
      allocations: { m1: [alloc("a1", 80, "2026-01-01", "2026-06-01"), alloc("a2", 80, "2026-01-01", "2026-06-01")] },
      existingClash: { id: "clash_inv", status: "investigating" },
    });
    await expect(detectOverAllocation(db.client, WS, "m1", actor())).resolves.toBe(true);
    expect(db.payload("clashes", "insert")).toBeUndefined();
    expect(db.payload("clashes", "update")).toBeDefined();
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });
});

describe("detectOverAllocationSafe", () => {
  it("returns a warning instead of throwing when detection fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = makeDb({
      members: MEMBERS,
      allocations: { m1: [alloc("a1", 80, null, null), alloc("a2", 80, null, null)] },
      insertError: { message: "boom" },
    });
    const out = await detectOverAllocationSafe(db.client, WS, "m1", actor());
    expect(out.detected).toBe(false);
    expect(out.warning).toMatch(/allocation was saved/);
    spy.mockRestore();
  });
  it("passes the result through on success", async () => {
    const db = makeDb({ members: MEMBERS, allocations: { m1: [alloc("a1", 50, null, null)] } });
    await expect(detectOverAllocationSafe(db.client, WS, "m1", actor())).resolves.toEqual({ detected: false, warning: null });
  });
});
