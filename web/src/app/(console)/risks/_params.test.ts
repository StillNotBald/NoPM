import { describe, it, expect } from "vitest";
import { parseRiskPageParams } from "./_params";

describe("parseRiskPageParams impact_area (K2 any-of)", () => {
  it("parses a comma list into a de-duplicated array of known areas", () => {
    expect(parseRiskPageParams({ impact_area: "cost,schedule,cost,morale" }).impact_area).toEqual(["cost", "schedule"]);
  });
  it("ignores an empty or all-unknown value", () => {
    expect(parseRiskPageParams({ impact_area: "morale" }).impact_area).toBeUndefined();
    expect(parseRiskPageParams({}).impact_area).toBeUndefined();
  });
});
