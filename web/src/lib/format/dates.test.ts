/**
 * formatByPref (L-42) — the one shared date formatter for registers/task
 * lists/dashboard. "Now" is pinned with fake timers so relative labels
 * ("Today", "In 3d", "2d ago") are deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { formatAbsoluteDate, formatRelativeDate, formatByPref } from "./dates";

// Pin the process timezone so day-boundary math (startOfDay, in the module
// under test) is deterministic regardless of the machine running the suite —
// otherwise "In 3d" vs "In 2d" could flip depending on local UTC offset.
process.env.TZ = "UTC";

const NOW = new Date("2026-08-15T09:00:00.000Z"); // matches the session's "today"

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatAbsoluteDate", () => {
  it("renders en-GB day/short-month/year", () => {
    expect(formatAbsoluteDate("2026-08-15")).toBe("15 Aug 2026");
  });

  it("returns the em-dash for null/undefined", () => {
    expect(formatAbsoluteDate(null)).toBe("—");
    expect(formatAbsoluteDate(undefined)).toBe("—");
  });

  it("returns the em-dash for an unparseable date instead of 'Invalid Date'", () => {
    expect(formatAbsoluteDate("not-a-date")).toBe("—");
  });
});

describe("formatRelativeDate", () => {
  it("labels today, tomorrow, yesterday", () => {
    expect(formatRelativeDate("2026-08-15")).toBe("Today");
    expect(formatRelativeDate("2026-08-16")).toBe("Tomorrow");
    expect(formatRelativeDate("2026-08-14")).toBe("Yesterday");
  });

  it("labels the near future/past window in days", () => {
    expect(formatRelativeDate("2026-08-18")).toBe("In 3d");
    expect(formatRelativeDate("2026-08-21")).toBe("In 6d");
    expect(formatRelativeDate("2026-08-12")).toBe("3d ago");
    expect(formatRelativeDate("2026-08-09")).toBe("6d ago");
  });

  it("falls back to the absolute string outside the +/-6 day window", () => {
    expect(formatRelativeDate("2026-08-22")).toBe(formatAbsoluteDate("2026-08-22"));
    expect(formatRelativeDate("2026-08-08")).toBe(formatAbsoluteDate("2026-08-08"));
  });

  it("returns the em-dash for null/undefined/unparseable", () => {
    expect(formatRelativeDate(null)).toBe("—");
    expect(formatRelativeDate("garbage")).toBe("—");
  });
});

describe("formatByPref", () => {
  it("absolute pref returns the absolute string as `text`", () => {
    const result = formatByPref("2026-08-18", "absolute");
    expect(result.text).toBe(formatAbsoluteDate("2026-08-18"));
  });

  it("relative pref returns the relative string as `text`", () => {
    const result = formatByPref("2026-08-18", "relative");
    expect(result.text).toBe("In 3d");
  });

  it("`absolute` is ALWAYS the absolute string regardless of pref (never relative)", () => {
    const rel = formatByPref("2026-08-18", "relative");
    const abs = formatByPref("2026-08-18", "absolute");
    expect(rel.absolute).toBe(formatAbsoluteDate("2026-08-18"));
    expect(abs.absolute).toBe(formatAbsoluteDate("2026-08-18"));
    expect(rel.absolute).toBe(abs.absolute);
  });

  it("`title` is always the machine ISO date, even in relative mode — never empty when a date exists", () => {
    const result = formatByPref("2026-08-18T00:00:00.000Z", "relative");
    expect(result.title).toBe("2026-08-18");
    expect(result.text).not.toBe(result.title); // relative text is NOT the raw ISO date
  });

  it("`title` is empty for a missing date, in both modes", () => {
    expect(formatByPref(null, "relative").title).toBe("");
    expect(formatByPref(null, "absolute").title).toBe("");
  });

  it("relative pref still resolves to the absolute string outside the near-term window", () => {
    const result = formatByPref("2026-08-22", "relative");
    expect(result.text).toBe(formatAbsoluteDate("2026-08-22"));
    expect(result.text).toBe(result.absolute);
  });
});
