import { describe, it, expect } from "vitest";
import { computeSprintSnapshot } from "./snapshot";

describe("computeSprintSnapshot", () => {
  it("sums story points and records a per-task snapshot map", () => {
    const result = computeSprintSnapshot([
      { id: "t1", story_points: 3 },
      { id: "t2", story_points: 5 },
      { id: "t3", story_points: 2 },
    ]);
    expect(result.points).toBe(10);
    expect(result.snapshot).toEqual({ t1: 3, t2: 5, t3: 2 });
  });

  it("treats null/undefined story_points as 0", () => {
    const result = computeSprintSnapshot([
      { id: "t1", story_points: null },
      { id: "t2", story_points: 4 },
    ]);
    expect(result.points).toBe(4);
    expect(result.snapshot).toEqual({ t1: 0, t2: 4 });
  });

  it("returns a flat zero snapshot for an empty task list (zero-transition sprint)", () => {
    const result = computeSprintSnapshot([]);
    expect(result.points).toBe(0);
    expect(result.snapshot).toEqual({});
  });

  it("handles fractional points and rounds to 1 decimal place", () => {
    const result = computeSprintSnapshot([
      { id: "t1", story_points: 1.25 },
      { id: "t2", story_points: 1.25 },
    ]);
    expect(result.points).toBe(2.5);
  });

  it("coerces numeric-string story_points (as Postgres numeric may arrive over the wire)", () => {
    const result = computeSprintSnapshot([{ id: "t1", story_points: "3.5" }]);
    expect(result.points).toBe(3.5);
    expect(result.snapshot).toEqual({ t1: 3.5 });
  });

  it("treats a non-numeric string as 0 rather than throwing", () => {
    const result = computeSprintSnapshot([{ id: "t1", story_points: "not-a-number" }]);
    expect(result.points).toBe(0);
    expect(result.snapshot).toEqual({ t1: 0 });
  });
});
