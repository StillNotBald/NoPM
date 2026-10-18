// Pure date helpers for seeding back-dated, weekday-aligned demo data
// (F2c T2 — sprints + timesheets seed). All dates are plain YYYY-MM-DD
// strings, parsed/formatted in UTC so they match the DB `date` column
// semantics used across the app (see api/timesheet-submissions/_schema.ts's
// isMonday, which uses the same UTC convention).
//
// Plain ESM, no TypeScript: scripts/*.mjs run via bare `node`, with no TS
// loader configured for the scripts/ directory (unlike src/, which vitest
// transpiles). Keeping this pure-logic module in plain JS lets both the
// seed script (scripts/seed-sprints-timesheets.mjs) and the vitest suite
// (src/lib/seed/working-days.test.ts, which imports this file directly by
// relative path) share the exact same implementation — no duplicated logic
// to drift between a "real" TS version and a hand-copied .mjs version.

/** Parse a YYYY-MM-DD string as a UTC Date at midnight. */
export function parseISO(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`);
}

/** Format a Date back to YYYY-MM-DD (UTC). */
export function toISO(date) {
  return date.toISOString().slice(0, 10);
}

/** Add `days` (may be negative) to a YYYY-MM-DD string, returning YYYY-MM-DD. */
export function addDays(dateStr, days) {
  const d = parseISO(dateStr);
  d.setUTCDate(d.getUTCDate() + days);
  return toISO(d);
}

/**
 * The Monday (YYYY-MM-DD) on or before `dateStr`, UTC week (Mon=1..Sun=0).
 * Matches the Monday-first week the `ts_period_is_one_week` CHECK and
 * createTimesheetSubmissionSchema's isMonday enforce (migration 0038 /
 * api/timesheet-submissions/_schema.ts).
 */
export function mondayOf(dateStr) {
  const d = parseISO(dateStr);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return toISO(d);
}

/**
 * Every Mon-Fri date (YYYY-MM-DD) in [startDateStr, endDateStr] inclusive,
 * ascending; weekends are skipped. Used to spread back-dated task.update
 * audit rows across a sprint's *working* days so a burndown chart shows a
 * realistic business-day cadence instead of weekend blips.
 */
export function workingDaysInRange(startDateStr, endDateStr) {
  const out = [];
  let cur = parseISO(startDateStr);
  const end = parseISO(endDateStr);
  while (cur.getTime() <= end.getTime()) {
    const day = cur.getUTCDay();
    if (day !== 0 && day !== 6) out.push(toISO(cur));
    cur = new Date(cur.getTime() + 86_400_000);
  }
  return out;
}

/**
 * Pick up to `n` evenly-spaced items from `arr` (stable relative order),
 * e.g. to spread a handful of task-completion events across a longer list
 * of working days rather than clustering them at the start. Returns the
 * full array when `n >= arr.length`; returns [] when `n <= 0` or `arr` is
 * empty.
 */
export function evenlySpaced(arr, n) {
  if (n <= 0 || arr.length === 0) return [];
  if (n >= arr.length) return [...arr];
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (arr.length - 1)) / (n - 1 || 1));
    out.push(arr[idx]);
  }
  return out;
}
