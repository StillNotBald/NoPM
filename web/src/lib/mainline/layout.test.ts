import { describe, it, expect } from "vitest";
import {
  dateToX,
  laneIndexByProject,
  topoLevels,
  packDagPositions,
  capLabels,
} from "./layout";

// ---------------------------------------------------------------------------
// dateToX
// ---------------------------------------------------------------------------
describe("dateToX — date-to-pixel scale", () => {
  it("places the axis midpoint at half the width", () => {
    expect(dateToX("2026-01-16", "2026-01-01", "2026-01-31", 300)).toBeCloseTo(150, 0);
  });

  it("clamps a date before the axis start to 0", () => {
    expect(dateToX("2025-12-01", "2026-01-01", "2026-01-31", 300)).toBe(0);
  });

  it("clamps a date after the axis end to the full width", () => {
    expect(dateToX("2026-03-01", "2026-01-01", "2026-01-31", 300)).toBe(300);
  });

  it("returns 0 for a degenerate axis (end <= start)", () => {
    expect(dateToX("2026-01-10", "2026-01-31", "2026-01-01", 300)).toBe(0);
    expect(dateToX("2026-01-10", "2026-01-01", "2026-01-01", 300)).toBe(0);
  });

  it("returns 0 for an unparseable date rather than NaN", () => {
    expect(dateToX("not-a-date", "2026-01-01", "2026-01-31", 300)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// laneIndexByProject
// ---------------------------------------------------------------------------
describe("laneIndexByProject — one lane per project, first-seen order", () => {
  it("assigns sequential indices in input order", () => {
    const lanes = laneIndexByProject(["p1", "p2", "p3"]);
    expect(lanes.get("p1")).toBe(0);
    expect(lanes.get("p2")).toBe(1);
    expect(lanes.get("p3")).toBe(2);
  });

  it("dedupes repeated ids, keeping the first-seen index", () => {
    const lanes = laneIndexByProject(["p1", "p2", "p1"]);
    expect(lanes.size).toBe(2);
    expect(lanes.get("p1")).toBe(0);
  });

  it("empty input yields an empty map", () => {
    expect(laneIndexByProject([]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// topoLevels
// ---------------------------------------------------------------------------
describe("topoLevels — longest-path DAG leveling", () => {
  it("every node with no predecessors is level 0", () => {
    const levels = topoLevels(["a", "b", "c"], []);
    expect(levels.get("a")).toBe(0);
    expect(levels.get("b")).toBe(0);
    expect(levels.get("c")).toBe(0);
  });

  it("a linear chain levels sequentially", () => {
    const levels = topoLevels(
      ["a", "b", "c"],
      [{ from: "a", to: "b" }, { from: "b", to: "c" }],
    );
    expect(levels.get("a")).toBe(0);
    expect(levels.get("b")).toBe(1);
    expect(levels.get("c")).toBe(2);
  });

  it("a diamond takes the LONGEST path into the sink node", () => {
    // a -> b -> d
    // a -> c -> d  (same length here, but the point is d must be >= both)
    const levels = topoLevels(
      ["a", "b", "c", "d"],
      [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
        { from: "c", to: "d" },
      ],
    );
    expect(levels.get("d")).toBe(2);
  });

  it("ignores edges whose endpoint is outside the given node set", () => {
    const levels = topoLevels(["a", "b"], [{ from: "a", to: "ghost" }, { from: "ghost", to: "b" }]);
    expect(levels.get("a")).toBe(0);
    expect(levels.get("b")).toBe(0); // no valid in-set edge reaches b
  });

  it("ignores a self-loop", () => {
    const levels = topoLevels(["a"], [{ from: "a", to: "a" }]);
    expect(levels.get("a")).toBe(0);
  });

  it("never hangs or drops a node on a cycle — every id still gets a level", () => {
    // a <-> b cycle, c independent
    const levels = topoLevels(
      ["a", "b", "c"],
      [{ from: "a", to: "b" }, { from: "b", to: "a" }],
    );
    expect(levels.size).toBe(3);
    expect(levels.get("c")).toBe(0);
    expect(levels.get("a")).toBeGreaterThan(0);
    expect(levels.get("b")).toBeGreaterThan(0);
  });

  it("empty graph returns an empty map", () => {
    expect(topoLevels([], []).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// packDagPositions
// ---------------------------------------------------------------------------
describe("packDagPositions — grid layout from levels", () => {
  it("places every node id, x increasing strictly with level", () => {
    const pos = packDagPositions(
      ["a", "b", "c"],
      [{ from: "a", to: "b" }, { from: "b", to: "c" }],
      { colGap: 100 },
    );
    expect(pos.size).toBe(3);
    expect(pos.get("a")!.x).toBe(0);
    expect(pos.get("b")!.x).toBe(100);
    expect(pos.get("c")!.x).toBe(200);
  });

  it("centers nodes within the same level around y=0", () => {
    const pos = packDagPositions(["a", "b", "c"], [], { rowGap: 40 });
    const ys = ["a", "b", "c"].map((id) => pos.get(id)!.y).sort((x, y) => x - y);
    // 3 nodes at rowGap 40 => offsets -40, 0, 40
    expect(ys).toEqual([-40, 0, 40]);
  });

  it("a single node in a level sits at y=0", () => {
    const pos = packDagPositions(["only"], []);
    expect(pos.get("only")!.y).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// capLabels
// ---------------------------------------------------------------------------
describe("capLabels — perf guard for label-density", () => {
  it("shows every label when count is within the cap", () => {
    expect(capLabels(5, 10)).toEqual([true, true, true, true, true]);
  });

  it("caps to at most `max` visible labels when count exceeds it", () => {
    const flags = capLabels(200, 20);
    expect(flags.length).toBe(200);
    const shown = flags.filter(Boolean).length;
    expect(shown).toBeLessThanOrEqual(20);
    expect(shown).toBeGreaterThan(0);
  });

  it("always includes the first and last index when capping", () => {
    const flags = capLabels(50, 5);
    expect(flags[0]).toBe(true);
    expect(flags[49]).toBe(true);
  });

  it("zero count returns an empty array", () => {
    expect(capLabels(0, 10)).toEqual([]);
  });

  it("max <= 0 hides every label without throwing", () => {
    expect(capLabels(10, 0)).toEqual(new Array(10).fill(false));
  });
});
