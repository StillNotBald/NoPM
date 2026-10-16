import { describe, it, expect } from "vitest";
import {
  allDayBounds,
  buildMilestoneCalendar,
  escapeText,
  foldLine,
  type CalendarMilestone,
} from "./ics";

const CRLF = "\r\n";
const HOST = "app.example.com";
const APP = "https://app.example.com";
const ID = "3f2c1a9e-0000-4000-8000-000000000001";
const PROJECT = "7b1d0c4e-0000-4000-8000-0000000000aa";

function milestone(overrides: Partial<CalendarMilestone> = {}): CalendarMilestone {
  return {
    id: ID,
    name: "Beta release",
    target_date: "2026-10-30",
    status: "on_track",
    completion_pct: 40,
    description: null,
    project_id: PROJECT,
    project_name: "Launch",
    updated_at: "2026-10-16T08:30:05.123Z",
    ...overrides,
  };
}

function build(milestones: CalendarMilestone[], calName = "NoPM milestones", appUrl = APP) {
  return buildMilestoneCalendar({ calName, host: HOST, appUrl, milestones });
}

/** Physical lines as written on the wire (folded continuations still separate). */
function physicalLines(ics: string): string[] {
  return ics.split(CRLF).slice(0, -1);
}

/** Logical lines after RFC 5545 §3.1 unfolding (CRLF + one space removed). */
function logicalLines(ics: string): string[] {
  return ics.replace(/\r\n /g, "").split(CRLF).slice(0, -1);
}

function eventsIn(ics: string): string[][] {
  const events: string[][] = [];
  let current: string[] | null = null;
  for (const line of logicalLines(ics)) {
    if (line === "BEGIN:VEVENT") current = [];
    else if (line === "END:VEVENT" && current) {
      events.push(current);
      current = null;
    } else if (current) current.push(line);
  }
  return events;
}

const byteLength = (s: string) => Buffer.byteLength(s, "utf8");

describe("line endings and envelope", () => {
  it("terminates every line with CRLF and never emits a bare LF or CR", () => {
    const ics = build([milestone()]);
    expect(ics.endsWith(CRLF)).toBe(true);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("opens and closes the calendar in order", () => {
    const lines = logicalLines(build([milestone()]));
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines[lines.length - 1]).toBe("END:VCALENDAR");
  });

  it("writes the required calendar properties", () => {
    const lines = logicalLines(build([], "Team plan"));
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("PRODID:-//NoPM//Milestone Calendar//EN");
    expect(lines).toContain("CALSCALE:GREGORIAN");
    expect(lines).toContain("METHOD:PUBLISH");
    expect(lines).toContain("X-WR-CALNAME:Team plan");
  });

  it("returns a valid event-less calendar for an empty list", () => {
    const ics = build([]);
    expect(logicalLines(ics)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//NoPM//Milestone Calendar//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "X-WR-CALNAME:NoPM milestones",
      "END:VCALENDAR",
    ]);
    expect(eventsIn(ics)).toEqual([]);
  });

  it("escapes the calendar name", () => {
    expect(logicalLines(build([], "Team, Q4; plan"))).toContain("X-WR-CALNAME:Team\\, Q4\\; plan");
  });
});

describe("line folding (RFC 5545 section 3.1)", () => {
  it("leaves a line of 75 octets or fewer untouched", () => {
    expect(foldLine("SUMMARY:Short")).toBe("SUMMARY:Short");
    expect(foldLine("a".repeat(75))).toBe("a".repeat(75));
  });

  it("folds a 76-octet line with a single leading space on the continuation", () => {
    expect(foldLine("a".repeat(76))).toBe(`${"a".repeat(75)}${CRLF} a`);
  });

  it("keeps every physical line at 75 octets or fewer and unfolds back to the original", () => {
    const line = `SUMMARY:${"x".repeat(200)}`;
    const physical = foldLine(line).split(CRLF);
    expect(physical[0]).toHaveLength(75);
    for (const part of physical.slice(1)) {
      expect(part.startsWith(" ")).toBe(true);
      expect(byteLength(part)).toBeLessThanOrEqual(75);
    }
    expect(physical.map((part, i) => (i === 0 ? part : part.slice(1))).join("")).toBe(line);
  });

  it("counts a 3-byte character as 3 octets: 25 CJK characters fill the first line exactly", () => {
    const physical = foldLine("中".repeat(60)).split(CRLF);
    expect(physical).toEqual(["中".repeat(25), ` ${"中".repeat(24)}`, ` ${"中".repeat(11)}`]);
    for (const part of physical) expect(byteLength(part)).toBeLessThanOrEqual(75);
  });

  it("never splits a multi-byte character across a fold", () => {
    // 74 ASCII octets leave one octet free; the 3-byte character must move whole.
    expect(foldLine(`${"a".repeat(74)}中b`)).toBe(`${"a".repeat(74)}${CRLF} 中b`);
  });

  it("counts a 4-byte emoji as 4 octets and keeps surrogate pairs intact", () => {
    const physical = foldLine("😀".repeat(30)).split(CRLF);
    expect(physical[0]).toBe("😀".repeat(18));
    expect(physical[1]).toBe(` ${"😀".repeat(12)}`);
    for (const part of physical) expect(part).not.toContain("�");
  });

  it("folds long DESCRIPTION text so no physical line of the whole feed exceeds 75 octets", () => {
    const ics = build([
      milestone({
        name: "Ship the 中文 launch with a deliberately long name that keeps going and going",
        description: "中文说明😀 ".repeat(40),
      }),
    ]);
    for (const part of physicalLines(ics)) {
      expect(byteLength(part)).toBeLessThanOrEqual(75);
    }
  });
});

describe("TEXT escaping (RFC 5545 section 3.3.11)", () => {
  it("escapes semicolons and commas", () => {
    expect(escapeText("a;b,c")).toBe("a\\;b\\,c");
  });

  it("escapes backslashes", () => {
    expect(escapeText("a\\b")).toBe("a\\\\b");
  });

  it("escapes backslash before the other escapes, not after", () => {
    // Input `\;` must become `\\\;` (escaped backslash, then escaped semicolon).
    expect(escapeText("\\;")).toBe("\\\\\\;");
  });

  it("turns LF, CRLF and bare CR into a single \\n", () => {
    expect(escapeText("one\ntwo")).toBe("one\\ntwo");
    expect(escapeText("one\r\ntwo")).toBe("one\\ntwo");
    expect(escapeText("one\rtwo")).toBe("one\\ntwo");
  });

  it("applies escaping to SUMMARY in the built event", () => {
    const ics = build([milestone({ name: "Q4, plan; v2\nnotes", project_name: null })]);
    expect(logicalLines(ics)).toContain("SUMMARY:Q4\\, plan\\; v2\\nnotes");
  });
});

describe("all-day date bounds", () => {
  it("gives the same day as start and the next day as the exclusive end", () => {
    expect(allDayBounds("2026-10-16")).toEqual({ start: "20261016", end: "20261017" });
  });

  it("rolls December 31 over to January 1 of the next year", () => {
    expect(allDayBounds("2026-12-31")).toEqual({ start: "20261231", end: "20270101" });
  });

  it("rolls February 28 over to March 1 in a non-leap year", () => {
    expect(allDayBounds("2027-02-28")).toEqual({ start: "20270228", end: "20270301" });
  });

  it("rolls February 28 over to February 29 in a leap year", () => {
    expect(allDayBounds("2028-02-28")).toEqual({ start: "20280228", end: "20280229" });
  });

  it("rolls February 29 over to March 1 in a leap year", () => {
    expect(allDayBounds("2028-02-29")).toEqual({ start: "20280229", end: "20280301" });
  });

  it("rejects dates that do not exist instead of rolling them over", () => {
    expect(allDayBounds("2027-02-29")).toBeNull();
    expect(allDayBounds("2026-02-30")).toBeNull();
    expect(allDayBounds("2026-13-01")).toBeNull();
  });

  it("rejects anything that is not a date-only string", () => {
    expect(allDayBounds("2026-10-16T00:00:00Z")).toBeNull();
    expect(allDayBounds("16/10/2026")).toBeNull();
    expect(allDayBounds("")).toBeNull();
  });

  it("emits DTSTART and DTEND across a year boundary in the feed", () => {
    const lines = logicalLines(build([milestone({ target_date: "2026-12-31" })]));
    expect(lines).toContain("DTSTART;VALUE=DATE:20261231");
    expect(lines).toContain("DTEND;VALUE=DATE:20270101");
  });
});

describe("VEVENT content", () => {
  it("skips milestones with no target date and milestones with an impossible one", () => {
    const ics = build([
      milestone({ id: "a", target_date: null }),
      milestone({ id: "b", target_date: "2027-02-29" }),
      milestone({ id: "c", target_date: "2026-10-30" }),
    ]);
    const events = eventsIn(ics);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain(`UID:milestone-c@${HOST}`);
  });

  it("builds a stable UID from the milestone id and the host", () => {
    const [event] = eventsIn(build([milestone()]));
    expect(event).toContain(`UID:milestone-${ID}@${HOST}`);
  });

  it("writes DTSTAMP in UTC from updated_at, converting a non-UTC offset", () => {
    const [event] = eventsIn(build([milestone({ updated_at: "2026-10-16T16:30:05+08:00" })]));
    expect(event).toContain("DTSTAMP:20261016T083005Z");
  });

  it("uses updated_at epoch seconds as SEQUENCE so each edit bumps it", () => {
    const updatedAt = "2026-10-16T08:30:05.123Z";
    const [event] = eventsIn(build([milestone({ updated_at: updatedAt })]));
    expect(event).toContain(`SEQUENCE:${Math.floor(Date.parse(updatedAt) / 1000)}`);
  });

  it("caps SEQUENCE at the 32-bit signed integer limit", () => {
    const [event] = eventsIn(build([milestone({ updated_at: "2100-01-01T00:00:00Z" })]));
    expect(event).toContain("SEQUENCE:2147483647");
  });

  it("refuses an unparseable updated_at rather than emitting a bad DTSTAMP", () => {
    expect(() => build([milestone({ updated_at: "not-a-date" })])).toThrow(RangeError);
  });

  it("prefixes the summary with the project name", () => {
    const [event] = eventsIn(build([milestone()]));
    expect(event).toContain("SUMMARY:Launch: Beta release");
  });

  it("uses the bare milestone name when there is no project name", () => {
    const [event] = eventsIn(build([milestone({ project_name: null })]));
    expect(event).toContain("SUMMARY:Beta release");
  });

  it("describes project, status, completion and notes, escaped as one TEXT value", () => {
    const [event] = eventsIn(
      build([milestone({ description: "Cut the release, then announce it" })]),
    );
    expect(event).toContain(
      "DESCRIPTION:Project: Launch\\nStatus: On track\\nCompletion: 40%\\nCut the release\\, then announce it",
    );
  });

  it("falls back to the raw status code when the status is not a known label", () => {
    const [event] = eventsIn(build([milestone({ status: "parked" })]));
    expect(event.join("\n")).toContain("Status: parked");
  });

  it("links to the project page and strips a trailing slash from the public origin", () => {
    const [event] = eventsIn(build([milestone()], "x", `${APP}/`));
    expect(event).toContain(`URL:${APP}/projects/${PROJECT}`);
  });

  it("marks all-day milestones transparent so they do not block free time", () => {
    const [event] = eventsIn(build([milestone()]));
    expect(event).toContain("TRANSP:TRANSPARENT");
  });

  it("emits one VEVENT per scheduled milestone, in the order given", () => {
    const ics = build([
      milestone({ id: "first", name: "One" }),
      milestone({ id: "second", name: "Two", target_date: "2026-11-01" }),
    ]);
    const events = eventsIn(ics);
    expect(events).toHaveLength(2);
    expect(events[0]).toContain("SUMMARY:Launch: One");
    expect(events[1]).toContain("SUMMARY:Launch: Two");
  });
});
