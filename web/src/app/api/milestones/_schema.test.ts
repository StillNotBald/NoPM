import { describe, it, expect } from "vitest";
import { createMilestoneSchema, updateMilestoneSchema } from "./_schema";

// UAT-035: the milestone column is a calendar date and every caller sends one, so the schema must accept it.
describe("milestone target_date", () => {
  it.each(["2026-12-31", "2026-12-31T00:00:00Z", "2026-12-31T08:00:00+08:00"])("accepts %s", (v) => {
    expect(createMilestoneSchema.safeParse({ name: "M", target_date: v }).success).toBe(true);
    expect(updateMilestoneSchema.safeParse({ target_date: v }).success).toBe(true);
  });

  it("accepts null and a missing date (a project made without dates still gets its starter milestones)", () => {
    expect(createMilestoneSchema.safeParse({ name: "M", target_date: null }).success).toBe(true);
    expect(createMilestoneSchema.safeParse({ name: "M" }).success).toBe(true);
  });

  it.each(["", "tomorrow", "2026-13-40", "31/12/2026"])("refuses %s", (v) => {
    expect(createMilestoneSchema.safeParse({ name: "M", target_date: v }).success).toBe(false);
  });
});
