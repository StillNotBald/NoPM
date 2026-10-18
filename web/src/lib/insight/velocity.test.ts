import { describe, it, expect } from "vitest";
import { computeVelocity, type ClosedSprintForVelocity } from "./velocity";

function sprint(
  id: string,
  name: string,
  committed: number | null,
  completed: number | null,
): ClosedSprintForVelocity {
  return { id, name, committed_points: committed, completed_points: completed };
}

describe("computeVelocity — insufficient history", () => {
  it("flags insufficient with zero closed sprints", () => {
    expect(computeVelocity([])).toEqual({ insufficient: true });
  });

  it("flags insufficient with exactly one closed sprint", () => {
    expect(computeVelocity([sprint("s1", "Sprint 1", 10, 8)])).toEqual({ insufficient: true });
  });
});

describe("computeVelocity — bars", () => {
  it("maps committed/completed points per sprint, preserving input order", () => {
    const result = computeVelocity([sprint("s1", "Sprint 1", 10, 8), sprint("s2", "Sprint 2", 12, 12)]);
    expect(result.insufficient).toBe(false);
    if (!result.insufficient) {
      expect(result.bars).toEqual([
        { id: "s1", name: "Sprint 1", committed: 10, completed: 8 },
        { id: "s2", name: "Sprint 2", committed: 12, completed: 12 },
      ]);
    }
  });

  it("treats null committed/completed points as 0", () => {
    const result = computeVelocity([sprint("s1", "Sprint 1", null, null), sprint("s2", "Sprint 2", 5, 5)]);
    expect(result.insufficient).toBe(false);
    if (!result.insufficient) {
      expect(result.bars[0]).toEqual({ id: "s1", name: "Sprint 1", committed: 0, completed: 0 });
    }
  });
});

describe("computeVelocity — rolling average", () => {
  it("averages ALL sprints when there are fewer than 3", () => {
    const result = computeVelocity([sprint("s1", "S1", 10, 6), sprint("s2", "S2", 10, 10)]);
    expect(result.insufficient).toBe(false);
    if (!result.insufficient) expect(result.rollingAverage).toBe(8); // (6+10)/2
  });

  it("averages only the LAST 3 sprints when there are more than 3", () => {
    const result = computeVelocity([
      sprint("s1", "S1", 10, 0), // excluded from the rolling window
      sprint("s2", "S2", 10, 6),
      sprint("s3", "S3", 10, 9),
      sprint("s4", "S4", 10, 12),
    ]);
    expect(result.insufficient).toBe(false);
    if (!result.insufficient) expect(result.rollingAverage).toBe(9); // (6+9+12)/3
  });

  it("rounds the average to 1 decimal place", () => {
    const result = computeVelocity([sprint("s1", "S1", 10, 5), sprint("s2", "S2", 10, 6)]);
    expect(result.insufficient).toBe(false);
    if (!result.insufficient) expect(result.rollingAverage).toBe(5.5);
  });
});
