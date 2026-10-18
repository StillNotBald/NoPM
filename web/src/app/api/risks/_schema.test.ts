import { describe, it, expect } from "vitest";
import { createRiskSchema, updateRiskSchema, resolveImpactAreas } from "./_schema";
import { unknownFieldsResponse } from "@/lib/work/unknown-fields";

const base = { title: "Vendor slips", severity: "high", likelihood: "medium" } as const;

describe("risk schema - K1 legacy category is gone", () => {
  it("does not know a `category` key (create and update)", () => {
    expect(Object.keys(createRiskSchema.shape)).not.toContain("category");
    expect(Object.keys(updateRiskSchema.shape)).not.toContain("category");
  });

  it("a stale `category` in a body is refused by the unknown-field guard, not silently dropped", async () => {
    const res = unknownFieldsResponse({ ...base, category: "Technical" }, createRiskSchema);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(422);
  });

  it("still accepts the enum risk_category", () => {
    expect(createRiskSchema.safeParse({ ...base, risk_category: "technical" }).success).toBe(true);
    expect(createRiskSchema.safeParse({ ...base, risk_category: "vibes" }).success).toBe(false);
  });
});

describe("risk schema - K2 impact_areas", () => {
  it("accepts an array of valid areas", () => {
    const r = createRiskSchema.safeParse({ ...base, impact_areas: ["cost", "schedule"] });
    expect(r.success).toBe(true);
  });

  it("accepts an empty array (no areas)", () => {
    expect(updateRiskSchema.safeParse({ impact_areas: [] }).success).toBe(true);
  });

  it("rejects an unknown area and more than six entries", () => {
    expect(createRiskSchema.safeParse({ ...base, impact_areas: ["morale"] }).success).toBe(false);
    expect(
      createRiskSchema.safeParse({
        ...base,
        impact_areas: ["schedule", "cost", "scope", "quality", "reputation", "compliance", "cost"],
      }).success,
    ).toBe(false);
  });

  it("still accepts impact_area as the one-element shorthand", () => {
    expect(createRiskSchema.safeParse({ ...base, impact_area: "cost" }).success).toBe(true);
    expect(createRiskSchema.safeParse({ ...base, impact_area: "morale" }).success).toBe(false);
  });
});

describe("resolveImpactAreas", () => {
  it("the array wins over the shorthand, and duplicates collapse", () => {
    expect(resolveImpactAreas({ impact_areas: ["cost", "cost", "scope"], impact_area: "quality" })).toEqual(["cost", "scope"]);
  });
  it("the shorthand becomes a one-element array; null clears", () => {
    expect(resolveImpactAreas({ impact_area: "cost" })).toEqual(["cost"]);
    expect(resolveImpactAreas({ impact_area: null })).toEqual([]);
  });
  it("nothing sent means no change (undefined)", () => {
    expect(resolveImpactAreas({})).toBeUndefined();
  });
});
