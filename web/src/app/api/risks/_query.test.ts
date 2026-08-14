import { describe, it, expect } from "vitest";
import { parseRiskFilters, applyRiskFilters, RISK_SORT_FIELDS } from "./_query";

describe("parseRiskFilters", () => {
  it("returns an empty object with no params", () => {
    expect(parseRiskFilters(new URLSearchParams())).toEqual({});
  });

  it("extracts status and severity", () => {
    const params = new URLSearchParams({ status: "open", severity: "high" });
    expect(parseRiskFilters(params)).toEqual({ status: "open", severity: "high" });
  });
});

describe("applyRiskFilters", () => {
  function mockQuery() {
    const calls: [string, unknown][] = [];
    const q = {
      eq(col: string, val: unknown) {
        calls.push([col, val]);
        return q;
      },
    };
    return { q, calls };
  }

  it("applies status and severity filters", () => {
    const { q, calls } = mockQuery();
    applyRiskFilters(q, { status: "open", severity: "critical" });
    expect(calls).toEqual([
      ["status", "open"],
      ["severity", "critical"],
    ]);
  });

  it("applies nothing when filters are empty", () => {
    const { q, calls } = mockQuery();
    applyRiskFilters(q, {});
    expect(calls).toEqual([]);
  });
});

describe("RISK_SORT_FIELDS", () => {
  it("is a fixed whitelist matching the list API", () => {
    expect(RISK_SORT_FIELDS).toEqual([
      "due_date",
      "severity",
      "likelihood",
      "status",
      "title",
      "created_at",
    ]);
  });
});
