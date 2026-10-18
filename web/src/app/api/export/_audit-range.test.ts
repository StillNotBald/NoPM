import { describe, it, expect } from "vitest";
import { parseExportDay, dayAfter } from "./_audit-range";

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
