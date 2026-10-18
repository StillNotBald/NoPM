import { describe, it, expect } from "vitest";
import {
  parseExportDay,
  dayAfter,
  parseExportRange,
  rangeColumn,
  applyExportRange,
} from "./_audit-range";

describe("parseExportDay", () => {
  it("accepts a real calendar day", () => {
    expect(parseExportDay("2026-10-17")).toBe("2026-10-17");
    expect(parseExportDay("2028-02-29")).toBe("2028-02-29");
  });
  it("drops malformed, impossible, or missing values", () => {
    expect(parseExportDay(null)).toBeUndefined();
    expect(parseExportDay("")).toBeUndefined();
    expect(parseExportDay("2026-10-17T00:00:00Z")).toBeUndefined();
    expect(parseExportDay("2026-02-30")).toBeUndefined();
    expect(parseExportDay("2027-02-29")).toBeUndefined();
    expect(parseExportDay("yesterday")).toBeUndefined();
  });
});

describe("dayAfter", () => {
  it("is the exclusive UTC upper bound for an inclusive `to` day", () => {
    expect(dayAfter("2026-10-17")).toBe("2026-10-18T00:00:00.000Z");
    expect(dayAfter("2026-12-31")).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("parseExportRange", () => {
  it("parses from, to and defaults on to created", () => {
    const r = parseExportRange(new URLSearchParams("from=2026-10-01&to=2026-10-17"));
    expect(r).toEqual({ from: "2026-10-01", to: "2026-10-17", on: "created" });
  });
  it("accepts on=updated and drops unknown values", () => {
    expect(parseExportRange(new URLSearchParams("on=updated")).on).toBe("updated");
    expect(parseExportRange(new URLSearchParams("on=whenever")).on).toBe("created");
  });
  it("drops malformed days instead of failing", () => {
    const r = parseExportRange(new URLSearchParams("from=2026-13-40&to=nope"));
    expect(r.from).toBeUndefined();
    expect(r.to).toBeUndefined();
  });
});

describe("rangeColumn", () => {
  it("uses updated_at only when asked and available", () => {
    expect(rangeColumn("updated", { hasUpdatedAt: true })).toBe("updated_at");
    expect(rangeColumn("updated", { hasUpdatedAt: false })).toBe("created_at");
    expect(rangeColumn("created", { hasUpdatedAt: true })).toBe("created_at");
  });
  it("honours a custom creation column", () => {
    expect(rangeColumn("updated", { hasUpdatedAt: false, createdColumn: "linked_at" })).toBe("linked_at");
  });
});

describe("applyExportRange", () => {
  function spy() {
    const calls: Array<[string, string, string]> = [];
    const q: Record<string, unknown> = {};
    q.gte = (c: string, v: string) => (calls.push(["gte", c, v]), q);
    q.lt = (c: string, v: string) => (calls.push(["lt", c, v]), q);
    return { q, calls };
  }
  it("applies an inclusive lower and exclusive next-day upper bound", () => {
    const { q, calls } = spy();
    applyExportRange(q, { from: "2026-10-01", to: "2026-10-17", on: "created" }, "created_at");
    expect(calls).toEqual([
      ["gte", "created_at", "2026-10-01T00:00:00Z"],
      ["lt", "created_at", "2026-10-18T00:00:00.000Z"],
    ]);
  });
  it("does nothing without a range", () => {
    const { q, calls } = spy();
    applyExportRange(q, { on: "created" }, "created_at");
    expect(calls).toEqual([]);
  });
});
