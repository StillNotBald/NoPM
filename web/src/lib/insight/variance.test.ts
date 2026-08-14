import { describe, it, expect } from "vitest";
import { taskVariance, projectVarianceRollup, OVERRUN_THRESHOLD_PCT } from "./variance";

describe("taskVariance — no estimate", () => {
  it("returns all-null and never flags an overrun when estimateHours is null", () => {
    expect(taskVariance({ id: "t1", estimateHours: null, actualHours: 40 })).toEqual({
      varianceHours: null,
      variancePct: null,
      isOverrun: false,
    });
  });

  it("treats undefined the same as null", () => {
    expect(taskVariance({ id: "t1", estimateHours: undefined, actualHours: 40 }).varianceHours).toBeNull();
  });
});

describe("taskVariance — under / at / over estimate", () => {
  it("negative variance when actuals come in under estimate", () => {
    const v = taskVariance({ id: "t1", estimateHours: 10, actualHours: 6 });
    expect(v.varianceHours).toBe(-4);
    expect(v.variancePct).toBe(-40);
    expect(v.isOverrun).toBe(false);
  });

  it("zero variance when actuals exactly match the estimate", () => {
    const v = taskVariance({ id: "t1", estimateHours: 10, actualHours: 10 });
    expect(v.varianceHours).toBe(0);
    expect(v.variancePct).toBe(0);
    expect(v.isOverrun).toBe(false);
  });

  it("positive variance under the overrun threshold is NOT flagged", () => {
    // 10 -> 11.5h = +15%, below the 20% threshold
    const v = taskVariance({ id: "t1", estimateHours: 10, actualHours: 11.5 });
    expect(v.variancePct).toBe(15);
    expect(v.isOverrun).toBe(false);
  });

  it("positive variance past the threshold IS flagged", () => {
    // 10 -> 13h = +30%
    const v = taskVariance({ id: "t1", estimateHours: 10, actualHours: 13 });
    expect(v.variancePct).toBe(30);
    expect(v.isOverrun).toBe(true);
  });

  it("sits exactly ON the threshold — strictly-greater-than means NOT flagged", () => {
    const v = taskVariance({ id: "t1", estimateHours: 100, actualHours: 100 + OVERRUN_THRESHOLD_PCT });
    expect(v.variancePct).toBe(OVERRUN_THRESHOLD_PCT);
    expect(v.isOverrun).toBe(false);
  });

  it("no time logged against an estimated task is a full negative variance, not null", () => {
    const v = taskVariance({ id: "t1", estimateHours: 8, actualHours: 0 });
    expect(v.varianceHours).toBe(-8);
    expect(v.variancePct).toBe(-100);
  });
});

describe("taskVariance — zero-hour estimate (divide-by-zero guard)", () => {
  it("a declared zero-hour estimate yields a real hours variance but a null %", () => {
    const v = taskVariance({ id: "t1", estimateHours: 0, actualHours: 3 });
    expect(v.varianceHours).toBe(3);
    expect(v.variancePct).toBeNull();
    expect(v.isOverrun).toBe(false); // guarded — never Infinity-flagged
  });
});

describe("taskVariance — rounding", () => {
  it("rounds hours and % to one decimal place (% is derived from the rounded hours figure)", () => {
    const v = taskVariance({ id: "t1", estimateHours: 3, actualHours: 4.06 });
    expect(v.varianceHours).toBe(1.1); // 1.06 -> 1.1
    expect(v.variancePct).toBe(36.7); // 1.1 / 3 * 100 = 36.66... -> 36.7
  });
});

// ---------------------------------------------------------------------------
// projectVarianceRollup
// ---------------------------------------------------------------------------

describe("projectVarianceRollup — empty / no-estimate-only project", () => {
  it("an empty task list rolls up to all-zero, null %, nothing excluded", () => {
    expect(projectVarianceRollup([])).toEqual({
      totalEstimateHours: 0,
      totalActualHours: 0,
      varianceHours: 0,
      variancePct: null,
      isOverrun: false,
      includedCount: 0,
      excludedCount: 0,
      excludedActualHours: 0,
    });
  });

  it("a project where NO task has an estimate excludes everything and reports null %", () => {
    const rollup = projectVarianceRollup([
      { id: "t1", estimateHours: null, actualHours: 5 },
      { id: "t2", estimateHours: null, actualHours: 3 },
    ]);
    expect(rollup.includedCount).toBe(0);
    expect(rollup.excludedCount).toBe(2);
    expect(rollup.excludedActualHours).toBe(8);
    expect(rollup.variancePct).toBeNull();
  });
});

describe("projectVarianceRollup — mixed estimate coverage", () => {
  it("states the exclusion count and keeps excluded actuals out of the % basis", () => {
    const rollup = projectVarianceRollup([
      { id: "t1", estimateHours: 10, actualHours: 12 }, // included: +2h
      { id: "t2", estimateHours: 5, actualHours: 4 },   // included: -1h
      { id: "t3", estimateHours: null, actualHours: 100 }, // excluded — must NOT skew the %
    ]);
    expect(rollup.includedCount).toBe(2);
    expect(rollup.excludedCount).toBe(1);
    expect(rollup.excludedActualHours).toBe(100);
    expect(rollup.totalEstimateHours).toBe(15);
    expect(rollup.totalActualHours).toBe(16); // 12 + 4, NOT +100
    expect(rollup.varianceHours).toBe(1);
    expect(rollup.variancePct).toBeCloseTo(6.7, 1);
  });

  it("flags a project-level overrun once the aggregate % clears the threshold", () => {
    const rollup = projectVarianceRollup([
      { id: "t1", estimateHours: 10, actualHours: 20 }, // +100%
    ]);
    expect(rollup.variancePct).toBe(100);
    expect(rollup.isOverrun).toBe(true);
  });

  it("tasks with no time logged still count toward includedCount and pull the % negative", () => {
    const rollup = projectVarianceRollup([
      { id: "t1", estimateHours: 10, actualHours: 0 },
    ]);
    expect(rollup.includedCount).toBe(1);
    expect(rollup.variancePct).toBe(-100);
  });
});
