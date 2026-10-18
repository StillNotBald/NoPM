import { describe, it, expect } from "vitest";
import {
  calculateCriticalPath,
  toCpmMap,
  type CpmInputTask,
  type CpmInputDep,
  type CpmResult,
} from "./cpm";

// ---------------------------------------------------------------------------
// Helpers
//
// The CPM pass works in whole-day offsets, so tests express tasks as
// (start offset, duration) pairs anchored on an arbitrary epoch date. Only the
// duration ever reaches the arithmetic — see the "start dates are ignored"
// block below.
// ---------------------------------------------------------------------------
const EPOCH_UTC = Date.UTC(2025, 0, 1); // 2025-01-01
const MS_PER_DAY = 86_400_000;

/** ISO yyyy-mm-dd for `dayOffset` days after 2025-01-01. */
function iso(dayOffset: number): string {
  return new Date(EPOCH_UTC + dayOffset * MS_PER_DAY).toISOString().slice(0, 10);
}

/** A task starting at `startOffset` and running for `durationDays`. */
function task(id: string, startOffset: number, durationDays: number): CpmInputTask {
  return { id, start_date: iso(startOffset), due_date: iso(startOffset + durationDays) };
}

function dep(predecessor_id: string, successor_id: string, lag_days = 0): CpmInputDep {
  return { predecessor_id, successor_id, type: "FS", lag_days };
}

/** Index results by id so assertions do not depend on array position. */
function byId(results: CpmResult[]): Map<string, CpmResult> {
  return toCpmMap(results);
}

// ---------------------------------------------------------------------------
// Degenerate inputs
// ---------------------------------------------------------------------------
describe("calculateCriticalPath — degenerate inputs", () => {
  it("returns an empty array for no tasks (and never touches deps)", () => {
    expect(calculateCriticalPath([], [])).toEqual([]);
    expect(calculateCriticalPath([], [dep("ghost_a", "ghost_b")])).toEqual([]);
  });

  it("returns a fully-zeroed, critical result for a single dateless task", () => {
    const [r] = calculateCriticalPath([{ id: "a", start_date: null, due_date: null }], []);
    expect(r).toEqual({
      id: "a",
      durationDays: 0,
      earlyStart: 0,
      earlyFinish: 0,
      lateStart: 0,
      lateFinish: 0,
      slack: 0,
      isCritical: true,
    });
  });

  it("a lone task spans its own duration and is critical (it *is* the project)", () => {
    const [r] = calculateCriticalPath([task("a", 0, 5)], []);
    expect(r.durationDays).toBe(5);
    expect(r.earlyStart).toBe(0);
    expect(r.earlyFinish).toBe(5);
    expect(r.lateStart).toBe(0);
    expect(r.lateFinish).toBe(5);
    expect(r.slack).toBe(0);
    expect(r.isCritical).toBe(true);
  });

  it("emits exactly one result per task, in input order", () => {
    const results = calculateCriticalPath(
      [task("c", 0, 1), task("a", 0, 2), task("b", 0, 3)],
      [dep("a", "b")],
    );
    expect(results.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Duration derivation
// ---------------------------------------------------------------------------
describe("calculateCriticalPath — duration derivation", () => {
  it("duration is due − start in whole UTC days", () => {
    const [r] = calculateCriticalPath(
      [{ id: "a", start_date: "2025-01-01", due_date: "2025-01-06" }],
      [],
    );
    expect(r.durationDays).toBe(5);
  });

  it("same-day task has zero duration (the window is half-open)", () => {
    const [r] = calculateCriticalPath(
      [{ id: "a", start_date: "2025-03-10", due_date: "2025-03-10" }],
      [],
    );
    expect(r.durationDays).toBe(0);
  });

  it("clamps an inverted window (due before start) to zero rather than going negative", () => {
    const [r] = calculateCriticalPath(
      [{ id: "a", start_date: "2025-06-30", due_date: "2025-06-01" }],
      [],
    );
    expect(r.durationDays).toBe(0);
  });

  it("treats a half-populated window as zero duration", () => {
    const results = calculateCriticalPath(
      [
        { id: "no_start", start_date: null, due_date: "2025-01-10" },
        { id: "no_due", start_date: "2025-01-01", due_date: null },
      ],
      [],
    );
    expect(results.map((r) => r.durationDays)).toEqual([0, 0]);
  });

  it("treats unparseable dates as absent (no NaN leaks into the pass)", () => {
    const [r] = calculateCriticalPath(
      [{ id: "a", start_date: "not-a-date", due_date: "2025-01-10" }],
      [],
    );
    expect(r.durationDays).toBe(0);
    expect(Number.isNaN(r.earlyFinish)).toBe(false);
    expect(r.earlyFinish).toBe(0);
  });

  it("ignores the time-of-day component (floors to the UTC day)", () => {
    const [r] = calculateCriticalPath(
      [{ id: "a", start_date: "2025-01-01T23:59:59Z", due_date: "2025-01-04T00:00:01Z" }],
      [],
    );
    expect(r.durationDays).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Forward / backward pass over a linear chain
// ---------------------------------------------------------------------------
describe("calculateCriticalPath — linear chain", () => {
  const tasks = [task("a", 0, 5), task("b", 5, 3), task("c", 8, 2)];
  const deps = [dep("a", "b"), dep("b", "c")];

  it("stacks early start/finish end to end", () => {
    const m = byId(calculateCriticalPath(tasks, deps));
    expect([m.get("a")!.earlyStart, m.get("a")!.earlyFinish]).toEqual([0, 5]);
    expect([m.get("b")!.earlyStart, m.get("b")!.earlyFinish]).toEqual([5, 8]);
    expect([m.get("c")!.earlyStart, m.get("c")!.earlyFinish]).toEqual([8, 10]);
  });

  it("late dates mirror early dates — every task on a single chain is critical", () => {
    const m = byId(calculateCriticalPath(tasks, deps));
    for (const id of ["a", "b", "c"]) {
      const r = m.get(id)!;
      expect(r.lateStart).toBe(r.earlyStart);
      expect(r.lateFinish).toBe(r.earlyFinish);
      expect(r.slack).toBe(0);
      expect(r.isCritical).toBe(true);
    }
  });

  it("the last task's late finish is the project finish", () => {
    const m = byId(calculateCriticalPath(tasks, deps));
    expect(m.get("c")!.lateFinish).toBe(10);
  });

  it("is insensitive to the order deps are supplied in", () => {
    const forward = byId(calculateCriticalPath(tasks, deps));
    const reversed = byId(calculateCriticalPath(tasks, [...deps].reverse()));
    for (const id of ["a", "b", "c"]) {
      expect(reversed.get(id)).toEqual(forward.get(id));
    }
  });
});

// ---------------------------------------------------------------------------
// Diamond — the shape that actually distinguishes critical from slack
// ---------------------------------------------------------------------------
describe("calculateCriticalPath — diamond (parallel branches)", () => {
  //        ┌── b (5d) ──┐
  //  a (2d)              d (2d)
  //        └── c (1d) ──┘
  const tasks = [task("a", 0, 2), task("b", 2, 5), task("c", 2, 1), task("d", 7, 2)];
  const deps = [dep("a", "b"), dep("a", "c"), dep("b", "d"), dep("c", "d")];

  it("the successor waits for the slowest branch", () => {
    const m = byId(calculateCriticalPath(tasks, deps));
    expect(m.get("d")!.earlyStart).toBe(7); // max(EF b = 7, EF c = 3)
    expect(m.get("d")!.earlyFinish).toBe(9);
  });

  it("the long branch is critical, the short branch carries float", () => {
    const m = byId(calculateCriticalPath(tasks, deps));
    expect(m.get("a")!.slack).toBe(0);
    expect(m.get("b")!.slack).toBe(0);
    expect(m.get("d")!.slack).toBe(0);
    expect(m.get("c")!.slack).toBe(4); // b takes 5d where c takes 1d
  });

  it("isCritical marks exactly the a→b→d path", () => {
    const critical = calculateCriticalPath(tasks, deps)
      .filter((r) => r.isCritical)
      .map((r) => r.id);
    expect(critical).toEqual(["a", "b", "d"]);
  });

  it("the slack task's late window is shifted right by its float", () => {
    const c = byId(calculateCriticalPath(tasks, deps)).get("c")!;
    expect(c.earlyStart).toBe(2);
    expect(c.earlyFinish).toBe(3);
    expect(c.lateStart).toBe(6);
    expect(c.lateFinish).toBe(7);
  });

  it("a merge point takes the *minimum* late start of its successors", () => {
    // a feeds both b (LS 2) and c (LS 6) → a must finish by 2
    const a = byId(calculateCriticalPath(tasks, deps)).get("a")!;
    expect(a.lateFinish).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Independent tasks / no dependencies
// ---------------------------------------------------------------------------
describe("calculateCriticalPath — no dependencies", () => {
  it("all tasks start at offset 0 and the longest one sets the project finish", () => {
    const m = byId(calculateCriticalPath([task("long", 0, 5), task("short", 0, 2)], []));
    expect(m.get("long")!.earlyStart).toBe(0);
    expect(m.get("short")!.earlyStart).toBe(0);
    expect(m.get("long")!.lateFinish).toBe(5);
    expect(m.get("short")!.lateFinish).toBe(5);
  });

  it("only the longest independent task is critical; the rest float", () => {
    const m = byId(calculateCriticalPath([task("long", 0, 5), task("short", 0, 2)], []));
    expect(m.get("long")!.isCritical).toBe(true);
    expect(m.get("short")!.slack).toBe(3);
    expect(m.get("short")!.isCritical).toBe(false);
  });

  it("zero-duration tasks alongside real work are non-critical, not degenerate", () => {
    const m = byId(
      calculateCriticalPath([task("real", 0, 4), { id: "milestone", start_date: null, due_date: null }], []),
    );
    expect(m.get("milestone")!.durationDays).toBe(0);
    expect(m.get("milestone")!.slack).toBe(4);
    expect(m.get("milestone")!.isCritical).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Start dates are structural only — the pass is offset-based
// ---------------------------------------------------------------------------
describe("calculateCriticalPath — start dates do not seed the forward pass", () => {
  it("a root task always starts at offset 0 however late its real start date is", () => {
    const [r] = calculateCriticalPath([task("late_starter", 200, 3)], []);
    expect(r.earlyStart).toBe(0);
    expect(r.earlyFinish).toBe(3);
  });

  it("shifting every calendar date by a constant leaves the whole result unchanged", () => {
    const deps = [dep("a", "b")];
    const early = calculateCriticalPath([task("a", 0, 4), task("b", 4, 2)], deps);
    const shifted = calculateCriticalPath([task("a", 90, 4), task("b", 500, 2)], deps);
    expect(shifted).toEqual(early);
  });
});

// ---------------------------------------------------------------------------
// Lag
// ---------------------------------------------------------------------------
describe("calculateCriticalPath — lag", () => {
  it("positive lag pushes the successor out and stays on the critical path", () => {
    const m = byId(
      calculateCriticalPath([task("a", 0, 2), task("b", 4, 3)], [dep("a", "b", 2)]),
    );
    expect(m.get("b")!.earlyStart).toBe(4); // EF(a)=2 + lag 2
    expect(m.get("b")!.earlyFinish).toBe(7);
    expect(m.get("a")!.lateFinish).toBe(2); // LS(b)=4 − lag 2
    expect(m.get("a")!.slack).toBe(0);
    expect(m.get("b")!.slack).toBe(0);
  });

  it("negative lag (lead) pulls the successor in", () => {
    const m = byId(
      calculateCriticalPath([task("a", 0, 4), task("b", 3, 2)], [dep("a", "b", -1)]),
    );
    expect(m.get("b")!.earlyStart).toBe(3);
    expect(m.get("b")!.earlyFinish).toBe(5);
  });

  it("the largest predecessor + lag wins at a merge", () => {
    // a: EF 2 + lag 5 = 7  vs  b: EF 4 + lag 0 = 4
    const m = byId(
      calculateCriticalPath(
        [task("a", 0, 2), task("b", 0, 4), task("c", 7, 1)],
        [dep("a", "c", 5), dep("b", "c", 0)],
      ),
    );
    expect(m.get("c")!.earlyStart).toBe(7);
    expect(m.get("b")!.slack).toBe(3); // b is not driving c
  });
});

// ---------------------------------------------------------------------------
// Dependency filtering
// ---------------------------------------------------------------------------
describe("calculateCriticalPath — dependency filtering", () => {
  it("drops deps whose predecessor is outside the task set", () => {
    const m = byId(calculateCriticalPath([task("b", 0, 3)], [dep("not_in_set", "b")]));
    expect(m.get("b")!.earlyStart).toBe(0);
    expect(m.get("b")!.slack).toBe(0);
  });

  it("drops deps whose successor is outside the task set", () => {
    const m = byId(calculateCriticalPath([task("a", 0, 3)], [dep("a", "not_in_set")]));
    expect(m.get("a")!.lateFinish).toBe(3); // no phantom successor constrains it
  });

  it("a filtered-out link leaves both ends independent", () => {
    // Only `a` is in scope; the a→b link is dropped with b.
    const withPartner = byId(calculateCriticalPath([task("a", 0, 3), task("b", 3, 4)], [dep("a", "b")]));
    const alone = byId(calculateCriticalPath([task("a", 0, 3)], [dep("a", "b")]));
    expect(withPartner.get("a")!.earlyFinish).toBe(3);
    expect(alone.get("a")!.lateFinish).toBe(3);
    expect(alone.get("a")!.slack).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Relationship types — hand-computed expectations
// ---------------------------------------------------------------------------
describe("calculateCriticalPath — relationship types", () => {
  const typed = (type: CpmInputDep["type"], lag_days = 0): CpmInputDep => ({
    predecessor_id: "a",
    successor_id: "b",
    type,
    lag_days,
  });
  const run = (type: CpmInputDep["type"], lag = 0, durA = 4, durB = 2) =>
    byId(calculateCriticalPath([task("a", 0, durA), task("b", 0, durB)], [typed(type, lag)]));

  it("FS: successor starts when the predecessor finishes", () => {
    const m = run("FS");
    expect([m.get("b")!.earlyStart, m.get("b")!.earlyFinish]).toEqual([4, 6]);
    expect(m.get("a")!.slack).toBe(0);
  });

  it("SS: successor starts when the predecessor starts (+ lag)", () => {
    const m = run("SS", 1);
    expect([m.get("b")!.earlyStart, m.get("b")!.earlyFinish]).toEqual([1, 3]);
    // project finish is a's 4; b has float 1, and a is critical
    expect(m.get("a")!.isCritical).toBe(true);
    expect(m.get("b")!.slack).toBe(1);
  });

  it("FF: successor finishes when the predecessor finishes (+ lag)", () => {
    const m = run("FF", 1, 4, 2);
    expect(m.get("b")!.earlyFinish).toBe(5);
    expect(m.get("b")!.earlyStart).toBe(3);
    expect(m.get("b")!.slack).toBe(0);
    expect(m.get("a")!.slack).toBe(0);
  });

  it("SF: successor finishes relative to the predecessor's start (+ lag)", () => {
    const m = run("SF", 5, 4, 2);
    // EF(b) >= ES(a) + 5 = 5, so ES(b) = 3
    expect([m.get("b")!.earlyStart, m.get("b")!.earlyFinish]).toEqual([3, 5]);
  });

  it("FF constraint is clamped at offset 0 when it would start the successor early", () => {
    const m = run("FF", 0, 1, 5);
    expect(m.get("b")!.earlyStart).toBe(0);
  });

  it("backward pass honours SS: predecessor float follows the successor", () => {
    // a(3) SS b(6) lag 0 : b is the long task, so project finish = 6.
    const m = byId(
      calculateCriticalPath([task("a", 0, 3), task("b", 0, 6)], [typed("SS")]),
    );
    expect(m.get("b")!.slack).toBe(0);
    expect(m.get("a")!.lateStart).toBe(0);
    expect(m.get("a")!.lateFinish).toBe(3);
    expect(m.get("a")!.slack).toBe(0);
  });

  it("backward pass honours FF: predecessor late finish is bounded by the successor's", () => {
    // a(2) FF b(5): LF(a) <= LF(b) = 5, so a has 3 days of float
    const m = byId(
      calculateCriticalPath([task("a", 0, 2), task("b", 0, 5)], [typed("FF")]),
    );
    expect(m.get("a")!.lateFinish).toBe(5);
    expect(m.get("a")!.slack).toBe(3);
  });

  it("a mixed network keeps float non-negative for every task", () => {
    const tasks = [task("a", 0, 3), task("b", 0, 4), task("c", 0, 2), task("d", 0, 5)];
    const mixed: CpmInputDep[] = [
      { predecessor_id: "a", successor_id: "b", type: "SS", lag_days: 1 },
      { predecessor_id: "b", successor_id: "c", type: "FF", lag_days: 0 },
      { predecessor_id: "a", successor_id: "d", type: "FS", lag_days: 0 },
      { predecessor_id: "c", successor_id: "d", type: "SF", lag_days: 2 },
    ];
    for (const r of calculateCriticalPath(tasks, mixed)) {
      expect(r.slack).toBeGreaterThanOrEqual(0);
      expect(r.earlyFinish - r.earlyStart).toBe(r.durationDays);
      expect(r.lateFinish - r.lateStart).toBe(r.durationDays);
    }
  });
});

// ---------------------------------------------------------------------------
// Cycles — must degrade, never hang
// ---------------------------------------------------------------------------
describe("calculateCriticalPath — cycles", () => {
  it("a two-node cycle terminates and still returns one result per task", () => {
    const results = calculateCriticalPath(
      [task("a", 0, 2), task("b", 0, 3)],
      [dep("a", "b"), dep("b", "a")],
    );
    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(results.every((r) => Number.isFinite(r.slack))).toBe(true);
  });

  it("falls back to input order, so the cycle resolves as if it were a chain", () => {
    // Kahn's queue starts empty → processOrder = input order [a, b].
    // `a` sees no computed predecessor yet (defaults to 0) and `b` chains off it.
    const m = byId(
      calculateCriticalPath([task("a", 0, 2), task("b", 0, 3)], [dep("a", "b"), dep("b", "a")]),
    );
    expect(m.get("a")!.earlyStart).toBe(0);
    expect(m.get("a")!.earlyFinish).toBe(2);
    expect(m.get("b")!.earlyStart).toBe(2);
    expect(m.get("b")!.earlyFinish).toBe(5);
  });

  it("a self-loop terminates and yields a self-consistent single task", () => {
    const [r] = calculateCriticalPath([task("a", 0, 2)], [dep("a", "a")]);
    expect(r.durationDays).toBe(2);
    expect(r.earlyStart).toBe(0);
    expect(r.earlyFinish).toBe(2);
    expect(r.lateFinish).toBe(2);
    expect(r.slack).toBe(0);
  });

  it("one cycle degrades the ordering for the whole graph, not just its members", () => {
    // With the cycle b↔c present, Kahn cannot complete, so even the clean
    // a-branch is processed in input order rather than topological order.
    const results = calculateCriticalPath(
      [task("c", 0, 1), task("b", 0, 1), task("a", 0, 4)],
      [dep("b", "c"), dep("c", "b"), dep("a", "c")],
    );
    expect(results.map((r) => r.id)).toEqual(["c", "b", "a"]);
    // `c` is evaluated before its predecessors exist → early start collapses to 0
    expect(results.find((r) => r.id === "c")!.earlyStart).toBe(0);
  });

  it("a three-node cycle does not hang", () => {
    const results = calculateCriticalPath(
      [task("a", 0, 1), task("b", 0, 1), task("c", 0, 1)],
      [dep("a", "b"), dep("b", "c"), dep("c", "a")],
    );
    expect(results).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// isCritical tolerance
// ---------------------------------------------------------------------------
describe("calculateCriticalPath — isCritical tolerance", () => {
  it("one full day of slack is NOT critical (tolerance is strict < 1)", () => {
    const m = byId(calculateCriticalPath([task("long", 0, 3), task("short", 0, 2)], []));
    expect(m.get("short")!.slack).toBe(1);
    expect(m.get("short")!.isCritical).toBe(false);
  });

  it("zero slack is critical", () => {
    const m = byId(calculateCriticalPath([task("long", 0, 3), task("same", 0, 3)], []));
    expect(m.get("same")!.slack).toBe(0);
    expect(m.get("same")!.isCritical).toBe(true);
  });

  it("every task is critical when they all share the project's duration", () => {
    const results = calculateCriticalPath([task("a", 0, 3), task("b", 0, 3), task("c", 0, 3)], []);
    expect(results.every((r) => r.isCritical)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toCpmMap
// ---------------------------------------------------------------------------
describe("toCpmMap", () => {
  it("returns an empty Map for an empty result set", () => {
    const m = toCpmMap([]);
    expect(m).toBeInstanceOf(Map);
    expect(m.size).toBe(0);
  });

  it("keys each result by its task id and preserves the object identity", () => {
    const results = calculateCriticalPath([task("a", 0, 2), task("b", 2, 3)], [dep("a", "b")]);
    const m = toCpmMap(results);
    expect(m.size).toBe(2);
    expect([...m.keys()]).toEqual(["a", "b"]);
    expect(m.get("a")).toBe(results[0]);
    expect(m.get("b")).toBe(results[1]);
  });

  it("misses return undefined rather than throwing", () => {
    expect(toCpmMap([]).get("nope")).toBeUndefined();
  });

  it("last write wins on duplicate ids", () => {
    const dup: CpmResult[] = [
      { id: "a", durationDays: 1, earlyStart: 0, earlyFinish: 1, lateStart: 0, lateFinish: 1, slack: 0, isCritical: true },
      { id: "a", durationDays: 9, earlyStart: 0, earlyFinish: 9, lateStart: 0, lateFinish: 9, slack: 0, isCritical: true },
    ];
    const m = toCpmMap(dup);
    expect(m.size).toBe(1);
    expect(m.get("a")!.durationDays).toBe(9);
  });
});
