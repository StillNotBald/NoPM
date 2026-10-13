/**
 * Shared date-display formatter (L-42).
 *
 * Before this file, every register/list page hand-rolled its own
 * `formatDate(iso)` (risks/page.tsx, issues/page.tsx, task-list.tsx,
 * dashboard/page.tsx, and several others) — all producing the same
 * `en-GB, "3 Jan 2026"` string. `formatByPref` is the ONE place that knows
 * how to render a date for display, so the new `dateDisplay` appearance
 * preference (absolute | relative) applies everywhere via one function
 * instead of N per-page forks.
 *
 * The per-file `formatDate` helpers already inside risks/issues detail
 * panels, decisions, documents, my-work, etc. are untouched here — this
 * task's acceptance criteria named registers, task lists and the dashboard
 * as the highest-traffic surfaces; the rest are flagged as a follow-up
 * suggestion in the sprint report, not silently rewritten.
 */

export const DATE_DISPLAYS = ["absolute", "relative"] as const;
export type DateDisplayPref = (typeof DATE_DISPLAYS)[number];

const ABSENT = "—";

/** `en-GB`, e.g. "3 Jan 2026" — the format every existing formatDate() used. */
export function formatAbsoluteDate(iso: string | null | undefined): string {
  if (!iso) return ABSENT;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return ABSENT;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

/**
 * "Today" / "Tomorrow" / "Yesterday" / "In 4d" / "6d ago" for anything
 * within a week either side of now; falls back to the absolute string
 * beyond that window (a bare "7w ago" is less scannable than a real date
 * once you're outside the near-term window PMs actually care about).
 */
export function formatRelativeDate(iso: string | null | undefined): string {
  if (!iso) return ABSENT;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return ABSENT;
  const diffDays = Math.round(
    (startOfDay(d).getTime() - startOfDay(new Date()).getTime()) / 86_400_000,
  );
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  if (diffDays > 1 && diffDays <= 6) return `In ${diffDays}d`;
  if (diffDays < -1 && diffDays >= -6) return `${Math.abs(diffDays)}d ago`;
  return formatAbsoluteDate(iso);
}

export interface FormattedDate {
  /** What to render — absolute or relative text depending on the preference. */
  text: string;
  /**
   * The absolute display string, ALWAYS computed regardless of `pref`.
   * Relative mode uses this for the title/tooltip so the exact date is
   * always one hover away, never lost behind "In 4d"; absolute mode gets
   * the same value in both fields.
   */
  absolute: string;
  /** Machine-readable ISO date for the title attribute, "" when there is no date. */
  title: string;
}

/** The one date formatter every date-display surface should call. */
export function formatByPref(
  iso: string | null | undefined,
  pref: DateDisplayPref,
): FormattedDate {
  const absolute = formatAbsoluteDate(iso);
  const text = pref === "relative" ? formatRelativeDate(iso) : absolute;
  const d = iso ? new Date(iso) : null;
  const title = d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : "";
  return { text, absolute, title };
}

/** Age in whole days of the oldest timestamp in `isoDates` (0 when empty). */
export function oldestAgeDays(isoDates: readonly string[], now: number = Date.now()): number {
  return isoDates.reduce(
    (m, iso) => Math.max(m, Math.floor((now - new Date(iso).getTime()) / 86_400_000)),
    0,
  );
}
