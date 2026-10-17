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
