/**
 * RFC 5545 serialiser for the milestone calendar feed (PLAN D10). Pure: no I/O
 * and no clock read. Every value, including each event's DTSTAMP, comes from
 * the caller's rows, so an unchanged workspace serialises to identical bytes
 * and the feed response can be cached for 15 minutes without drifting.
 */

const CRLF = "\r\n";
/** RFC 5545 §3.1: a content line is at most 75 octets before folding. */
const MAX_LINE_OCTETS = 75;
/** A continuation line spends one octet on the mandatory leading space. */
const MAX_CONTINUATION_OCTETS = 74;
/** SEQUENCE is a 32-bit signed INTEGER (RFC 5545 §3.3.8); epoch seconds fit until 2038. */
const MAX_SEQUENCE = 2_147_483_647;
const PRODID = "-//NoPM//Milestone Calendar//EN";
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const encoder = new TextEncoder();

const STATUS_LABELS: Record<string, string> = {
  not_started: "Not started",
  on_track: "On track",
  at_risk: "At risk",
  delayed: "Delayed",
  completed: "Completed",
};

export type CalendarMilestone = {
  id: string;
  name: string;
  /** Postgres `date` as PostgREST returns it (YYYY-MM-DD). Null = unscheduled, so no event. */
  target_date: string | null;
  status: string;
  completion_pct: number;
  description?: string | null;
  project_id: string;
  project_name?: string | null;
  /** When this revision was written (ISO 8601). Source of DTSTAMP and SEQUENCE. */
  updated_at: string;
  /**
   * When the project row was last written. The SUMMARY carries the project
   * name, so renaming a project changes every one of its events without
   * touching the milestone rows: the later of the two timestamps is the
   * revision, or subscribed clients would keep showing the old name.
   */
  project_updated_at?: string | null;
};

export type MilestoneCalendarInput = {
  calName: string;
  /** Host of the public app URL. It is the UID domain, so UIDs stay stable per deployment. */
  host: string;
  /** Public app origin, e.g. https://app.example. Deep links are built from it. */
  appUrl: string;
  milestones: CalendarMilestone[];
};

type DateBounds = { start: string; end: string };

/**
 * RFC 5545 §3.3.11 TEXT escaping. Backslash goes first so the escapes added
 * for the other characters are not escaped a second time.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/**
 * Fold one content line at 75 octets (RFC 5545 §3.1). Continuation lines start
 * with a single space and hold at most 74 more octets. Folding walks code
 * points rather than bytes, so a multi-byte UTF-8 character is never split
 * across two physical lines (a split would corrupt it for every client).
 */
export function foldLine(line: string): string {
  const physical: string[] = [];
  let current = "";
  let used = 0;
  let limit = MAX_LINE_OCTETS;
  for (const char of line) {
    const size = encoder.encode(char).byteLength;
    if (used + size > limit) {
      physical.push(current);
      current = "";
      used = 0;
      limit = MAX_CONTINUATION_OCTETS;
    }
    current += char;
    used += size;
  }
  physical.push(current);
  return physical.map((part, i) => (i === 0 ? part : ` ${part}`)).join(CRLF);
}

/**
 * All-day DTSTART and DTEND as YYYYMMDD. DTEND is exclusive, so it is the
 * following calendar day. Returns null for anything that is not a real date:
 * the round-trip check rejects 2026-02-30 instead of letting Date roll it over
 * silently into March.
 */
export function allDayBounds(isoDate: string): DateBounds | null {
  const match = DATE_ONLY.exec(isoDate);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const start = utcDate(year, monthIndex, day);
  if (
    start.getUTCFullYear() !== year ||
    start.getUTCMonth() !== monthIndex ||
    start.getUTCDate() !== day
  ) {
    return null;
  }
  return {
    start: compactDate(start),
    end: compactDate(utcDate(year, monthIndex, day + 1)),
  };
}

/** Date.UTC maps years 0-99 onto 1900-1999; setUTCFullYear does not, so use it. */
function utcDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

function compactDate(date: Date): string {
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
}

/** DTSTAMP in UTC, form #2 of RFC 5545 §3.3.5: YYYYMMDDTHHMMSSZ. */
function utcStamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`Invalid updated_at timestamp: ${iso}`);
  const date = new Date(ms);
  const time = [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join("");
  return `${compactDate(date)}T${time}Z`;
}

/**
 * SEQUENCE is the revision number a subscribed client compares against. Using
 * the row's updated_at (epoch seconds) means every edit bumps it and an
 * untouched milestone keeps the same value across fetches.
 */
function sequenceOf(iso: string): number {
  return Math.min(Math.floor(Date.parse(iso) / 1000), MAX_SEQUENCE);
}

/** The later of the milestone's and its project's write time (an unparseable project time is ignored). */
function revisionOf(milestone: CalendarMilestone): string {
  const project = milestone.project_updated_at;
  if (project && Date.parse(project) > Date.parse(milestone.updated_at)) return project;
  return milestone.updated_at;
}

function eventDescription(milestone: CalendarMilestone): string {
  const notes = milestone.description?.trim();
  return [
    milestone.project_name ? `Project: ${milestone.project_name}` : null,
    `Status: ${STATUS_LABELS[milestone.status] ?? milestone.status}`,
    `Completion: ${milestone.completion_pct}%`,
    notes ? notes : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function eventLines(
  milestone: CalendarMilestone,
  bounds: DateBounds,
  host: string,
  appUrl: string,
): string[] {
  const summary = milestone.project_name
    ? `${milestone.project_name}: ${milestone.name}`
    : milestone.name;
  return [
    "BEGIN:VEVENT",
    `UID:${escapeText(`milestone-${milestone.id}@${host}`)}`,
    `DTSTAMP:${utcStamp(revisionOf(milestone))}`,
    `SEQUENCE:${sequenceOf(revisionOf(milestone))}`,
    `DTSTART;VALUE=DATE:${bounds.start}`,
    `DTEND;VALUE=DATE:${bounds.end}`,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(eventDescription(milestone))}`,
    // URL is a URI value, not TEXT, so it is deliberately not escaped.
    `URL:${appUrl}/projects/${milestone.project_id}`,
    // All-day milestones should not mark the subscriber's time as busy.
    "TRANSP:TRANSPARENT",
    "END:VEVENT",
  ];
}

/**
 * Serialise scheduled milestones as an RFC 5545 calendar. Milestones without a
 * valid target date are skipped; a row with an unparseable updated_at throws,
 * because a silently dropped or mis-stamped event is worse than a failed fetch.
 * An empty list still yields a valid (event-less) calendar.
 */
export function buildMilestoneCalendar(input: MilestoneCalendarInput): string {
  const appUrl = input.appUrl.replace(/\/+$/, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(input.calName)}`,
  ];
  for (const milestone of input.milestones) {
    const bounds = milestone.target_date ? allDayBounds(milestone.target_date) : null;
    if (!bounds) continue;
    lines.push(...eventLines(milestone, bounds, input.host, appUrl));
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join(CRLF)}${CRLF}`;
}
