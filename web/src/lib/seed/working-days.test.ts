import { describe, it, expect } from "vitest";
// Plain-JS module lives under scripts/lib (no TS loader is configured for
// scripts/*.mjs — see that file's header comment) — vitest can still import
// it directly by relative path since it's already valid ESM.
import {
  addDays,
  mondayOf,
  workingDaysInRange,
  evenlySpaced,
} from "../../../scripts/lib/working-days.mjs";

describe("addDays", () => {
  it("adds a positive offset within a month", () => {
    expect(addDays("2026-08-15", 1)).toBe("2026-08-16");
  });

  it("crosses a month boundary", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
  });

  it("supports negative offsets", () => {
    expect(addDays("2026-08-15", -20)).toBe("2026-07-26");
  });

  it("is a no-op for +0", () => {
    expect(addDays("2026-08-15", 0)).toBe("2026-08-15");
  });
});

describe("mondayOf", () => {
  it("returns the same date when already a Monday", () => {
    // 2026-08-10 is a Monday.
    expect(mondayOf("2026-08-10")).toBe("2026-08-10");
  });

  it("walks back to the preceding Monday for a mid-week date", () => {
    // 2026-08-14 is a Friday in the same week as the Monday above.
    expect(mondayOf("2026-08-14")).toBe("2026-08-10");
  });

  it("walks back to the preceding Monday for a Saturday", () => {
    expect(mondayOf("2026-08-15")).toBe("2026-08-10");
  });

  it("treats Sunday as the last day of the ISO week (walks back 6 days)", () => {
    expect(mondayOf("2026-08-16")).toBe("2026-08-10");
  });
});

describe("workingDaysInRange", () => {
  it("includes every day of a Mon-Fri range", () => {
    expect(workingDaysInRange("2026-08-10", "2026-08-14")).toEqual([
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
      "2026-08-13",
      "2026-08-14",
    ]);
  });

  it("skips a weekend spanning the range", () => {
    // Fri 2026-08-14 .. Mon 2026-08-17 -> Fri + Mon only.
    expect(workingDaysInRange("2026-08-14", "2026-08-17")).toEqual([
      "2026-08-14",
      "2026-08-17",
    ]);
  });

  it("returns [] when the range is entirely a weekend", () => {
    // Sat 2026-08-15 .. Sun 2026-08-16.
    expect(workingDaysInRange("2026-08-15", "2026-08-16")).toEqual([]);
  });

  it("returns a single day when start === end and it's a weekday", () => {
    expect(workingDaysInRange("2026-08-10", "2026-08-10")).toEqual(["2026-08-10"]);
  });
});

describe("evenlySpaced", () => {
  it("returns the full array when n >= length", () => {
    expect(evenlySpaced([1, 2, 3], 5)).toEqual([1, 2, 3]);
    expect(evenlySpaced([1, 2, 3], 3)).toEqual([1, 2, 3]);
  });

  it("spreads picks across the array rather than clustering at the start", () => {
    const days = ["d0", "d1", "d2", "d3", "d4", "d5", "d6"];
    expect(evenlySpaced(days, 3)).toEqual(["d0", "d3", "d6"]);
  });

  it("returns a single (first) item for n=1", () => {
    expect(evenlySpaced(["a", "b", "c"], 1)).toEqual(["a"]);
  });

  it("returns [] for n<=0", () => {
    expect(evenlySpaced([1, 2, 3], 0)).toEqual([]);
    expect(evenlySpaced([1, 2, 3], -1)).toEqual([]);
  });

  it("returns [] for an empty input array regardless of n", () => {
    expect(evenlySpaced([], 3)).toEqual([]);
  });
});
