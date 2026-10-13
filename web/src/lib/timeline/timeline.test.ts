import { describe, expect, it } from "vitest";
import { barLayout, computeBounds, markerX, monthTicks, weekStartCols } from "./scale";
import { fmtSlip, iterDays, slipDays, slipPhrase, toDay } from "./dates";
import { describeBar, fmtRange } from "./labels";

describe("timeline dates", () => {
  it("computes slip in days", () => {
    expect(slipDays("2026-03-14", "2026-03-10")).toBe(4);
    expect(slipDays("2026-03-10", "2026-03-14")).toBe(-4);
    expect(slipDays(null, "2026-03-10")).toBeNull();
  });
  it("formats slip", () => {
    expect(fmtSlip(4)).toBe("+4d");
    expect(fmtSlip(-2)).toBe("-2d");
    expect(fmtSlip(0)).toBeNull();
    expect(slipPhrase(4)).toBe("slipped 4 days");
    expect(slipPhrase(1)).toBe("slipped 1 day");
    expect(slipPhrase(-2)).toBe("ahead 2 days");
    expect(slipPhrase(null)).toBeNull();
  });
  it("iterates consecutive days", () => {
    const d = iterDays(toDay("2026-03-01"), 3);
    expect(d).toHaveLength(3);
    expect(toDay(d[2]) - toDay(d[0])).toBe(2);
  });
});

describe("timeline scale", () => {
  it("pads bounds and falls back with no dates", () => {
    const min = toDay("2026-03-01");
    const b = computeBounds(["2026-03-01", "2026-03-10", null], 0);
    expect(b.minDay).toBe(min - 14);
    expect(b.maxDay).toBe(toDay("2026-03-10") + 28);
    expect(b.totalDays).toBe(b.maxDay - b.minDay + 1);
    expect(computeBounds([], 100)).toEqual({ minDay: 86, maxDay: 160, totalDays: 75 });
  });
  it("lays out inclusive bars with a one-day floor", () => {
    const min = toDay("2026-03-01");
    expect(barLayout("2026-03-03", "2026-03-05", min, 10)).toEqual({ left: 20, width: 30 });
    expect(barLayout(null, "2026-03-05", min, 10)).toEqual({ left: 50, width: 10 });
    expect(barLayout("2026-03-05", null, min, 10)).toEqual({ left: 40, width: 10 });
    expect(barLayout(null, null, min, 10)).toBeNull();
  });
  it("centres markers", () => {
    expect(markerX("2026-03-02", toDay("2026-03-01"), 10)).toBe(15);
  });
  it("ticks months and weeks", () => {
    const min = toDay("2026-03-25");
    const t = monthTicks(min, 20);
    expect(t.length).toBe(2);
    expect(t[0].col).toBe(0);
    expect(weekStartCols(min, 20).length).toBeGreaterThan(0);
  });
});

describe("timeline labels", () => {
  it("describes a bar in text", () => {
    const s = describeBar({
      name: "X",
      start: "2026-03-03",
      end: "2026-03-14",
      critical: true,
      slip: 4,
      pref: "absolute",
    });
    expect(s).toBe("Task X, 3 Mar 2026 to 14 Mar 2026, critical path, slipped 4 days");
  });
  it("degrades ranges", () => {
    expect(fmtRange(null, null, "absolute")).toBe("no dates");
    expect(fmtRange(null, "2026-03-14", "absolute")).toBe("due 14 Mar 2026");
  });
});
