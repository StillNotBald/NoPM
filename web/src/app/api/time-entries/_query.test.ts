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

  it("extracts date_from and date_to (L-28/L-30)", () => {
    const params = new URLSearchParams({ date_from: "2026-08-10", date_to: "2026-08-16" });
    expect(parseTimeEntryFilters(params)).toEqual({ date_from: "2026-08-10", date_to: "2026-08-16" });
  });

  it("extracts billable=true as boolean true", () => {
    const params = new URLSearchParams({ billable: "true" });
    expect(parseTimeEntryFilters(params)).toEqual({ billable: true });
  });

  it("extracts billable=false as boolean false", () => {
    const params = new URLSearchParams({ billable: "false" });
    expect(parseTimeEntryFilters(params)).toEqual({ billable: false });
  });

  it("ignores a malformed billable value rather than guessing", () => {
    const params = new URLSearchParams({ billable: "yes" });
    expect(parseTimeEntryFilters(params)).toEqual({});
  });
});

describe("applyTimeEntryFilters", () => {
  function mockQuery() {
    const calls: [string, string, unknown][] = [];
    const q = {
      eq(col: string, val: unknown) {
        calls.push(["eq", col, val]);
        return q;
      },
      gte(col: string, val: unknown) {
        calls.push(["gte", col, val]);
        return q;
      },
      lte(col: string, val: unknown) {
        calls.push(["lte", col, val]);
        return q;
      },
    };
    return { q, calls };
  }

  it("applies no calls when filters are empty", () => {
    const { q, calls } = mockQuery();
    applyTimeEntryFilters(q, {});
    expect(calls).toEqual([]);
  });

  it("applies project_id and member_id filters in order", () => {
    const { q, calls } = mockQuery();
    applyTimeEntryFilters(q, { project_id: "p1", member_id: "m1" });
    expect(calls).toEqual([
      ["eq", "project_id", "p1"],
      ["eq", "member_id", "m1"],
    ]);
  });

  it("applies date_from/date_to as gte/lte on entry_date, and billable as eq — in order", () => {
    const { q, calls } = mockQuery();
    applyTimeEntryFilters(q, {
      project_id: "p1",
      date_from: "2026-08-10",
      date_to: "2026-08-16",
      billable: false,
    });
    expect(calls).toEqual([
      ["eq", "project_id", "p1"],
      ["gte", "entry_date", "2026-08-10"],
      ["lte", "entry_date", "2026-08-16"],
      ["eq", "billable", false],
    ]);
  });

  it("applies billable=false (falsy value must still apply, not be treated as absent)", () => {
    const { q, calls } = mockQuery();
    applyTimeEntryFilters(q, { billable: false });
    expect(calls).toEqual([["eq", "billable", false]]);
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
