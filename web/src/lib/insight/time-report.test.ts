import { describe, it, expect } from "vitest";
import { aggregateTimeReport, type TimeEntryForReport } from "./time-report";

function entry(
  id: string,
  member_id: string,
  project_id: string | null,
  hours: number,
  cost: number,
  billable: boolean | null = true,
): TimeEntryForReport {
  return { id, member_id, project_id, hours, cost, billable };
}

describe("aggregateTimeReport — empty input", () => {
  it("returns all-zero totals and empty breakdowns", () => {
    const result = aggregateTimeReport([]);
    expect(result).toEqual({
      byMember: [],
      byProject: [],
      entryCount: 0,
      totalHours: 0,
      billableHours: 0,
      nonBillableHours: 0,
      totalCost: 0,
    });
  });
});

describe("aggregateTimeReport — grand totals", () => {
  it("sums hours and cost across all entries", () => {
    const result = aggregateTimeReport([
      entry("e1", "m1", "p1", 4, 400),
      entry("e2", "m2", "p2", 3, 150),
    ]);
    expect(result.totalHours).toBe(7);
    expect(result.totalCost).toBe(550);
    expect(result.entryCount).toBe(2);
  });

  it("splits billable vs non-billable hours", () => {
    const result = aggregateTimeReport([
      entry("e1", "m1", "p1", 4, 400, true),
      entry("e2", "m1", "p1", 2, 0, false),
    ]);
    expect(result.billableHours).toBe(4);
    expect(result.nonBillableHours).toBe(2);
    expect(result.totalHours).toBe(6);
  });

  it("treats a null billable flag as billable (matches the DB default)", () => {
    const result = aggregateTimeReport([entry("e1", "m1", "p1", 5, 500, null)]);
    expect(result.billableHours).toBe(5);
    expect(result.nonBillableHours).toBe(0);
  });
});

describe("aggregateTimeReport — by member", () => {
  it("groups totals per member, preserving first-seen order", () => {
    const result = aggregateTimeReport([
      entry("e1", "m2", "p1", 1, 10),
      entry("e2", "m1", "p1", 2, 20),
      entry("e3", "m2", "p1", 3, 30),
    ]);
    expect(result.byMember.map((m) => m.member_id)).toEqual(["m2", "m1"]);
    const m2 = result.byMember.find((m) => m.member_id === "m2")!;
    expect(m2.hours).toBe(4);
    expect(m2.cost).toBe(40);
  });

  it("splits billable/non-billable within a member's total", () => {
    const result = aggregateTimeReport([
      entry("e1", "m1", "p1", 3, 300, true),
      entry("e2", "m1", "p1", 1, 0, false),
    ]);
    const m1 = result.byMember[0];
    expect(m1.billableHours).toBe(3);
    expect(m1.nonBillableHours).toBe(1);
    expect(m1.hours).toBe(4);
  });
});

describe("aggregateTimeReport — by project", () => {
  it("groups totals per project", () => {
    const result = aggregateTimeReport([
      entry("e1", "m1", "p1", 2, 200),
      entry("e2", "m1", "p2", 3, 300),
      entry("e3", "m2", "p1", 1, 100),
    ]);
    const p1 = result.byProject.find((p) => p.project_id === "p1")!;
    expect(p1.hours).toBe(3);
    expect(p1.cost).toBe(300);
  });

  it("excludes entries with a null project_id from the by-project breakdown but keeps them in grand totals", () => {
    const result = aggregateTimeReport([entry("e1", "m1", null, 2, 200)]);
    expect(result.byProject).toEqual([]);
    expect(result.totalHours).toBe(2);
    expect(result.totalCost).toBe(200);
  });
});

describe("aggregateTimeReport — D14 cost is snapshot-only", () => {
  it("sums exactly the entry.cost values given — never re-derives from a rate", () => {
    // Two entries logged for the same member at DIFFERENT historical rates
    // (e.g. member's cost_rate changed between them) — the snapshot costs
    // must simply be summed as recorded, never recomputed from hours *
    // current_rate.
    const result = aggregateTimeReport([
      entry("e1", "m1", "p1", 2, 100), // logged at 50/hr
      entry("e2", "m1", "p1", 2, 140), // logged later at 70/hr
    ]);
    expect(result.totalCost).toBe(240);
    expect(result.byMember[0].cost).toBe(240);
  });

  it("accepts string-typed numeric hours/cost (Postgres numeric over the wire)", () => {
    const result = aggregateTimeReport([
      { id: "e1", member_id: "m1", project_id: "p1", hours: "3.5" as unknown as number, cost: "175.00" as unknown as number, billable: true },
    ]);
    expect(result.totalHours).toBe(3.5);
    expect(result.totalCost).toBe(175);
  });

  it("treats a null/non-numeric hours or cost as 0 rather than throwing", () => {
    const result = aggregateTimeReport([
      { id: "e1", member_id: "m1", project_id: "p1", hours: null, cost: null, billable: true },
    ]);
    expect(result.totalHours).toBe(0);
    expect(result.totalCost).toBe(0);
  });
});

describe("aggregateTimeReport — rounding", () => {
  it("rounds totals to 2 decimal places", () => {
    const result = aggregateTimeReport([
      entry("e1", "m1", "p1", 0.1, 0.1),
      entry("e2", "m1", "p1", 0.2, 0.2),
    ]);
    expect(result.totalHours).toBe(0.3);
    expect(result.totalCost).toBe(0.3);
  });
});
