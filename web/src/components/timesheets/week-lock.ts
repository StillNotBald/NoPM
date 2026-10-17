/**
 * Display-side mirror of the API's timesheet week lock
 * (lib/governance/period-lock.ts `weekLockState`).
 *
 * A member's week is FROZEN while a timesheet submission covers the entry date
 * and is
 *   - APPROVED   -> the period is closed (API code `period_locked`), or
 *   - SUBMITTED  -> the sheet is awaiting a decision (API code `timesheet_locked`),
 *     unless it was REOPENED (`reopened_at` set): reopen is the governed unlock,
 *     so a reopened sheet is open for amendment.
 *
 * The server is the authority; this only lets the UI say so BEFORE a write is
 * attempted. It lives apart from period-lock.ts because that module pulls in
 * server-only imports a client component must not bundle. A test pins the two
 * to the same answer for every status/reopen/date combination.
 */

export type WeekLock = "approved" | "under_review" | null;

export interface LockSubmission {
  period_start: string;
  period_end: string;
  status?: string | null;
  reopened_at?: string | null;
}

/** The one-line reason shown wherever a frozen week's controls are disabled. */
export const WEEK_LOCK_REASON: Record<Exclude<WeekLock, null>, string> = {
  under_review: "Submitted for approval — reopen to edit.",
  approved: "Approved — locked. Reopen to edit.",
};

/** API error codes that mean "this week is frozen". */
export const WEEK_LOCK_ERROR_CODES: readonly string[] = ["period_locked", "timesheet_locked"];

/** Which lock (if any) the submissions put on `date` (ISO YYYY-MM-DD). Approved outranks under review. */
export function lockForDate(date: string, submissions: readonly LockSubmission[]): WeekLock {
  let lock: WeekLock = null;
  for (const s of submissions) {
    if (date < s.period_start || date > s.period_end) continue;
    const status = s.status ?? "approved";
    if (status === "approved") return "approved";
    if (status === "submitted" && !s.reopened_at) lock = "under_review";
  }
  return lock;
}

/** The lock on a displayed week: the strictest lock on any of its days. */
export function lockForWeek(dates: readonly string[], submissions: readonly LockSubmission[]): WeekLock {
  let lock: WeekLock = null;
  for (const date of dates) {
    const l = lockForDate(date, submissions);
    if (l === "approved") return "approved";
    if (l) lock = l;
  }
  return lock;
}
