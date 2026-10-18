import { describe, it, expect } from "vitest";
import { sprintTimingFlag, sprintTimingMessage, todayInWorkspaceZone, withTimingFlag } from "./flags";
import { isUnfinished, unfinishedPrompt, parseDestination } from "./close";

const S = (state: string, start_date: string, end_date: string) => ({ state, start_date, end_date });

describe("sprint timing flags (Q-WRK-4 / Q-WRK-5)", () => {
  it("planned past its start -> late_to_start; the start day itself is not late", () => {
    expect(sprintTimingFlag(S("planned", "2026-10-01", "2026-10-14"), "2026-10-02")).toBe("late_to_start");
    expect(sprintTimingFlag(S("planned", "2026-10-02", "2026-10-14"), "2026-10-02")).toBeNull();
  });
  it("active past its end -> past_end; the end day itself is not", () => {
    expect(sprintTimingFlag(S("active", "2026-10-01", "2026-10-14"), "2026-10-15")).toBe("past_end");
    expect(sprintTimingFlag(S("active", "2026-10-01", "2026-10-14"), "2026-10-14")).toBeNull();
  });
  it("closed sprints are never flagged; a planned sprint past its END is late to start, not past end", () => {
    expect(sprintTimingFlag(S("closed", "2020-01-01", "2020-01-02"), "2026-10-15")).toBeNull();
    expect(sprintTimingFlag(S("planned", "2020-01-01", "2020-01-02"), "2026-10-15")).toBe("late_to_start");
  });
  it("messages and the computed field", () => {
    expect(sprintTimingMessage("late_to_start")).toContain("due to start");
    expect(sprintTimingMessage("past_end")).toContain("past its end date");
    expect(sprintTimingMessage(null)).toBeNull();
    expect(withTimingFlag(S("active", "2020-01-01", "2020-01-02"), "2026-10-15").timing_flag).toBe("past_end");
  });
  it("today is the Malaysia calendar date (UTC+8)", () => {
    expect(todayInWorkspaceZone(new Date("2026-10-17T17:00:00Z"))).toBe("2026-10-18");
    expect(todayInWorkspaceZone(new Date("2026-10-17T15:59:00Z"))).toBe("2026-10-17");
  });
});

describe("sprint close helpers (Q-WRK-20)", () => {
  it("completed and canceled are finished; everything else is not", () => {
    expect(isUnfinished("completed")).toBe(false);
    expect(isUnfinished("canceled")).toBe(false);
    for (const s of ["backlog", "unstarted", "started"]) expect(isUnfinished(s)).toBe(true);
  });
  it("prompt and destination parsing", () => {
    expect(unfinishedPrompt(1)).toContain("1 task is not finished");
    expect(unfinishedPrompt(4)).toContain("4 tasks are not finished");
    expect(parseDestination("backlog")).toEqual({ kind: "backlog" });
    expect(parseDestination("abc")).toEqual({ kind: "sprint", sprintId: "abc" });
  });
});
