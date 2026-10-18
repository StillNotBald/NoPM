/**
 * Shared scale / layout helpers for the day-grid timelines (Gantt, roadmap).
 */
import { iterDays, toDay } from "./dates";

export interface Span {
  left: number;
  width: number;
}

export interface Bounds {
  minDay: number;
  maxDay: number;
  totalDays: number;
}

/**
 * Padded day range covering every date. With no dates, falls back to
 * `[today - fallbackBefore, today + fallbackAfter]`.
 */
export function computeBounds(
  dates: Array<string | null | undefined>,
  todayDay: number,
  opts: { padBefore?: number; padAfter?: number; fallbackBefore?: number; fallbackAfter?: number } = {},
): Bounds {
  const { padBefore = 14, padAfter = 28, fallbackBefore = 14, fallbackAfter = 60 } = opts;
  const valid = dates.filter((d): d is string => !!d);
  if (valid.length === 0) {
    const minDay = todayDay - fallbackBefore;
    const maxDay = todayDay + fallbackAfter;
    return { minDay, maxDay, totalDays: maxDay - minDay + 1 };
  }
  const days = valid.map((d) => toDay(d));
  const minDay = Math.min(...days) - padBefore;
  const maxDay = Math.max(...days) + padAfter;
  return { minDay, maxDay, totalDays: maxDay - minDay + 1 };
}

/**
 * Pixel span of an inclusive start..end date pair (the end day is drawn in
 * full). One date only yields a one-day-wide bar. Null when both are absent.
 */
export function barLayout(
  start: string | null,
  end: string | null,
  minDay: number,
  dayW: number,
): Span | null {
  if (!start && !end) return null;
  const s = start ? (toDay(start) - minDay) * dayW : null;
  const e = end ? (toDay(end) - minDay) * dayW + dayW : null;
  const left = (s ?? e) as number;
  const right = e ?? (s as number) + dayW;
  return { left, width: Math.max(right - left, dayW) };
}

/** Pixel x of the centre of a single-day marker (milestone diamond). */
export function markerX(iso: string, minDay: number, dayW: number): number {
  return (toDay(iso) - minDay) * dayW + dayW / 2;
}

export interface MonthTick {
  label: string;
  col: number;
}

const MONTH_LOCALE = "en-GB"; // matches formatAbsoluteDate in lib/format/dates.ts

/** First-of-month boundary columns across the range, with a month label. */
export function monthTicks(
  minDay: number,
  totalDays: number,
  style: "long" | "short" = "long",
): MonthTick[] {
  const result: MonthTick[] = [];
  let last = -1;
  iterDays(minDay, totalDays).forEach((d, i) => {
    const m = d.getMonth();
    if (m !== last) {
      result.push({
        label: d.toLocaleDateString(MONTH_LOCALE, { month: style, year: "numeric" }),
        col: i,
      });
      last = m;
    }
  });
  return result;
}

/** Columns that start a week (Monday), excluding column 0. */
export function weekStartCols(minDay: number, totalDays: number): number[] {
  const cols: number[] = [];
  iterDays(minDay, totalDays).forEach((d, i) => {
    if (d.getDay() === 1 && i > 0) cols.push(i);
  });
  return cols;
}

/**
 * px per day so `totalDays` exactly fill `viewportPx` (the "Fit" view),
 * clamped so a very long range stays legible and a very short one is not
 * stretched into blocks. Unmeasured / degenerate input returns `fallback`.
 */
export function fitDayWidth(
  viewportPx: number,
  totalDays: number,
  opts: { min?: number; max?: number; fallback?: number } = {},
): number {
  const { min = 1, max = 40, fallback = 14 } = opts;
  if (!(viewportPx > 0) || !(totalDays > 0)) return fallback;
  return Math.min(Math.max(viewportPx / totalDays, min), max);
}

/**
 * `scrollLeft` that opens a time-axis view on today instead of on the data's
 * first date: today sits `leadDays` (at least a fifth of the window) from the
 * left edge, so recent history is visible and the near future fills the rest.
 * Clamped to the scrollable range. `todayX` is today's x within the content.
 */
export function scrollLeftForToday(
  todayX: number,
  viewportPx: number,
  contentPx: number,
  dayW: number,
  leadDays = 14,
): number {
  const lead = Math.max(leadDays * dayW, viewportPx * 0.2);
  const max = Math.max(contentPx - viewportPx, 0);
  return Math.min(Math.max(todayX - lead, 0), max);
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * First-of-month ISO dates inside [startIso, endIso] (both "YYYY-MM-DD"), each
 * with a short label: "Jul", or "Jan 2027" for January and for the first mark
 * so the year is always on screen. Pure calendar arithmetic (no Date, no
 * locale), so the labels cannot change with the runtime's ICU data.
 */
export function monthMarks(startIso: string, endIso: string): Array<{ iso: string; label: string }> {
  const [sy, sm, sd] = startIso.split("-").map(Number);
  if (!Number.isFinite(sy) || !Number.isFinite(sm) || !Number.isFinite(sd) || endIso < startIso) return [];
  let y = sy;
  let m = sd > 1 ? sm + 1 : sm; // the first month START inside the range
  if (m > 12) {
    m = 1;
    y += 1;
  }
  const marks: Array<{ iso: string; label: string }> = [];
  for (;;) {
    const iso = `${y}-${String(m).padStart(2, "0")}-01`;
    if (iso > endIso) break;
    marks.push({ iso, label: `${MONTH_ABBR[m - 1]}${marks.length === 0 || m === 1 ? ` ${y}` : ""}` });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return marks;
}
