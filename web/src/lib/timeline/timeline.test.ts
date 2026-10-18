import { describe, expect, it } from "vitest";
import { barLayout, computeBounds, fitDayWidth, markerX, monthMarks, monthTicks, scrollLeftForToday, weekStartCols } from "./scale";
import { fmtSlip, iterDays, slipDays, slipPhrase, toDay, todayIso } from "./dates";
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

describe("today helpers", () => {
  it("formats the injected clock as a local ISO date", () => {
    expect(todayIso(new Date(2026, 9, 17, 23, 59))).toBe("2026-10-17");
    expect(todayIso(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
  it("defaults to the real clock, not a frozen demo date", () => {
    expect(todayIso()).toBe(todayIso(new Date()));
    expect(todayIso()).not.toBe("2026-06-09");
  });
  it("opens the window at today with lead-in context", () => {
    // 14px/day, 700px window: lead is max(14*14=196, 700*0.2=140) = 196
    expect(scrollLeftForToday(1969, 700, 2702, 14)).toBe(1969 - 196);
    // phone, 260px window: lead is max(196, 52) = 196
    expect(scrollLeftForToday(1969, 260, 2702, 14)).toBe(1773);
  });
  it("clamps to the scrollable range", () => {
    expect(scrollLeftForToday(50, 700, 2702, 14)).toBe(0); // today near the start
    expect(scrollLeftForToday(2700, 700, 2702, 14)).toBe(2002); // never past content - window
    expect(scrollLeftForToday(500, 900, 600, 14)).toBe(0); // content narrower than window
  });
  it("fits a range to the window and clamps extremes", () => {
    expect(fitDayWidth(700, 100)).toBe(7);
    expect(fitDayWidth(700, 10)).toBe(40); // short range is not stretched past max
    expect(fitDayWidth(200, 1000)).toBe(1); // long range is not squeezed below min
    expect(fitDayWidth(0, 100)).toBe(14); // unmeasured -> fallback
    expect(fitDayWidth(700, 0, { fallback: 9 })).toBe(9);
  });
});

describe("monthMarks", () => {
  it("lists month starts inside the range, with the year on the first mark and on January", () => {
    const m = monthMarks("2026-05-30", "2027-02-14");
    expect(m.map((x) => x.iso)).toEqual([
      "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01",
      "2026-11-01", "2026-12-01", "2027-01-01", "2027-02-01",
    ]);
    expect(m.map((x) => x.label)).toEqual([
      "Jun 2026", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan 2027", "Feb",
    ]);
  });
  it("includes the start month when the range begins on the 1st", () => {
    expect(monthMarks("2026-06-01", "2026-06-20").map((x) => x.iso)).toEqual(["2026-06-01"]);
  });
  it("rolls a December start into January and survives degenerate input", () => {
    expect(monthMarks("2026-12-15", "2027-01-10").map((x) => x.iso)).toEqual(["2027-01-01"]);
    expect(monthMarks("2026-06-20", "2026-06-25")).toEqual([]);
    expect(monthMarks("2026-06-20", "2026-06-01")).toEqual([]);
    expect(monthMarks("nope", "2026-06-01")).toEqual([]);
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
