import { describe, it, expect } from "vitest";
import {
  parseTimeEntryFilters,
  applyTimeEntryFilters,
  resolveBillable,
} from "./_query";

describe("parseTimeEntryFilters", () => {
  it("returns an empty object when no filter params are present", () => {
    expect(parseTimeEntryFilters(new URLSearchParams())).toEqual({});
  });

  it("extracts project_id and member_id", () => {
    const params = new URLSearchParams({ project_id: "p1", member_id: "m1" });
    expect(parseTimeEntryFilters(params)).toEqual({ project_id: "p1", member_id: "m1" });
  });

  it("ignores unknown params", () => {
    const params = new URLSearchParams({ bogus: "x" });
    expect(parseTimeEntryFilters(params)).toEqual({});
  });
});

describe("applyTimeEntryFilters", () => {
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

  it("applies no .eq() calls when filters are empty", () => {
    const { q, calls } = mockQuery();
    applyTimeEntryFilters(q, {});
    expect(calls).toEqual([]);
  });

  it("applies project_id and member_id filters in order", () => {
    const { q, calls } = mockQuery();
    applyTimeEntryFilters(q, { project_id: "p1", member_id: "m1" });
    expect(calls).toEqual([
      ["project_id", "p1"],
      ["member_id", "m1"],
    ]);
  });
});

describe("resolveBillable (L-29 default fallback)", () => {
  it("uses the explicit value when provided (true)", () => {
    expect(resolveBillable(true, false)).toBe(true);
  });

  it("uses the explicit value when provided (false)", () => {
    expect(resolveBillable(false, true)).toBe(false);
  });

  it("falls back to the project's default_billable when explicit is omitted", () => {
    expect(resolveBillable(undefined, false)).toBe(false);
    expect(resolveBillable(undefined, true)).toBe(true);
  });

  it("fails safe to true when both explicit and project default are absent", () => {
    expect(resolveBillable(undefined, null)).toBe(true);
    expect(resolveBillable(undefined, undefined)).toBe(true);
  });
});
