import { describe, it, expect } from "vitest";
import {
  computeProgramRollup,
  computeChildRag,
  type ProgramRollupChildInput,
} from "./program-rollup";

function child(overrides: Partial<ProgramRollupChildInput> = {}): ProgramRollupChildInput {
  return {
    projectId: "p1",
    completionPct: 50,
    plannedAmount: 1000,
    committedAmount: 500,
    actualAmount: 400,
    currency: "USD",
    allocatedHours: 20,
    capacityHours: 40,
    ...overrides,
  };
}

describe("computeProgramRollup", () => {
  it("zero children → explicit empty state, never NaN/0 masquerading as data", () => {
    const r = computeProgramRollup([]);
    expect(r.projectCount).toBe(0);
    expect(r.completionPct).toBeNull();
    expect(r.plannedAmount).toBe(0);
    expect(r.committedAmount).toBe(0);
    expect(r.actualAmount).toBe(0);
    expect(r.budgetVariance).toBe(0);
    expect(r.burnPct).toBeNull();
    expect(r.allocatedHours).toBe(0);
    expect(r.capacityHours).toBe(0);
    expect(r.allocatedVsCapacityPct).toBeNull();
    expect(r.currency).toBeNull();
  });

  it("single project — completion equals the child's own completion (BAC-weighted, one child)", () => {
    const r = computeProgramRollup([child({ completionPct: 30, plannedAmount: 1000 })]);
    expect(r.projectCount).toBe(1);
    expect(r.completionPct).toBe(30);
  });

  it("multiple projects — BAC-weighted completion average", () => {
    // p1: planned 1000, 20% done -> EV 200
    // p2: planned 3000, 60% done -> EV 1800
    // total planned 4000, total EV 2000 -> 50%
    const r = computeProgramRollup([
      child({ projectId: "p1", plannedAmount: 1000, completionPct: 20 }),
      child({ projectId: "p2", plannedAmount: 3000, completionPct: 60 }),
    ]);
    expect(r.plannedAmount).toBe(4000);
    expect(r.completionPct).toBe(50);
  });

  it("falls back to a simple average when every child has zero planned budget", () => {
    const r = computeProgramRollup([
      child({ plannedAmount: 0, committedAmount: 0, completionPct: 40 }),
      child({ plannedAmount: 0, committedAmount: 0, completionPct: 80 }),
    ]);
    expect(r.plannedAmount).toBe(0);
    expect(r.completionPct).toBe(60); // simple average, not BAC-weighted
  });

  it("budget variance and burn % aggregate across children", () => {
    const r = computeProgramRollup([
      child({ plannedAmount: 1000, actualAmount: 1200 }), // over
      child({ plannedAmount: 1000, actualAmount: 300 }),  // under
    ]);
    expect(r.plannedAmount).toBe(2000);
    expect(r.actualAmount).toBe(1500);
    expect(r.budgetVariance).toBe(500); // 2000 - 1500
    expect(r.burnPct).toBe(75); // 1500/2000*100
  });

  it("burn % is null when total planned is zero (divide-by-zero guard)", () => {
    const r = computeProgramRollup([child({ plannedAmount: 0, actualAmount: 100 })]);
    expect(r.burnPct).toBeNull();
  });

  it("allocated vs capacity aggregates hours and guards zero capacity", () => {
    const r = computeProgramRollup([
      child({ allocatedHours: 10, capacityHours: 20 }),
      child({ allocatedHours: 15, capacityHours: 20 }),
    ]);
    expect(r.allocatedHours).toBe(25);
    expect(r.capacityHours).toBe(40);
    expect(r.allocatedVsCapacityPct).toBe(62.5);
  });

  it("allocatedVsCapacityPct is null when total capacity is zero", () => {
    const r = computeProgramRollup([child({ allocatedHours: 5, capacityHours: 0 })]);
    expect(r.allocatedVsCapacityPct).toBeNull();
  });

  it("currency is the common value when every budgeted child agrees", () => {
    const r = computeProgramRollup([
      child({ currency: "USD", plannedAmount: 1000 }),
      child({ currency: "USD", plannedAmount: 500 }),
    ]);
    expect(r.currency).toBe("USD");
  });

  it("currency is null when budgeted children disagree (mixed — caller shows a dash)", () => {
    const r = computeProgramRollup([
      child({ currency: "USD", plannedAmount: 1000 }),
      child({ currency: "SGD", plannedAmount: 500 }),
    ]);
    expect(r.currency).toBeNull();
  });

  it("an unbudgeted child's currency never forces a mixed read on its own", () => {
    const r = computeProgramRollup([
      child({ currency: "USD", plannedAmount: 1000 }),
      child({ currency: "EUR", plannedAmount: 0, committedAmount: 0 }),
    ]);
    expect(r.currency).toBe("USD");
  });

  it("defends against non-finite inputs (NaN/Infinity never leak into the total)", () => {
    const r = computeProgramRollup([
      child({ plannedAmount: Number.NaN, actualAmount: Number.POSITIVE_INFINITY, completionPct: 50 }),
    ]);
    expect(r.plannedAmount).toBe(0);
    expect(r.actualAmount).toBe(0);
  });
});

describe("computeChildRag", () => {
  it("null with zero children", () => {
    expect(computeChildRag([])).toBeNull();
  });

  it("all complete → complete", () => {
    expect(computeChildRag(["complete", "complete"])).toBe("complete");
  });

  it("any red wins over amber/green/not_started", () => {
    expect(computeChildRag(["green", "amber", "red", "complete"])).toBe("red");
  });

  it("any amber (no red) wins over green/not_started", () => {
    expect(computeChildRag(["green", "amber", "not_started"])).toBe("amber");
  });

  it("any not_started (no red/amber) beats green", () => {
    expect(computeChildRag(["green", "not_started", "complete"])).toBe("not_started");
  });

  it("mix of green and complete (not all complete) → green", () => {
    expect(computeChildRag(["green", "complete"])).toBe("green");
  });
});
