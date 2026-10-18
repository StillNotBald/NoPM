/**
 * Shared day-granularity date math for the timeline renderers (Gantt,
 * portfolio roadmap, Mainline lenses). Pure: no React, no I/O.
 *
 * "Day number" = floor(local-midnight epoch ms / 86_400_000). Only
 * differences between day numbers are ever used, so the constant offset is
 * irrelevant; it matches the maths the renderers each used to inline.
 */

export const MS_PER_DAY = 86_400_000;

/**
 * Today as a local-calendar ISO date ("YYYY-MM-DD") in the RUNTIME's zone: for
 * browser/client use only. Server code must use workspaceToday() from
 * lib/integrations/time-zone (the server runs in UTC). `now` is injectable so
 * callers and tests never depend on the wall clock; call it per request or per
 * render, never at module scope.
 */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function startOfDay(iso: string): Date {
  const d = new Date(iso);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function toDay(d: Date | string): number {
  const dt = typeof d === "string" ? startOfDay(d) : d;
  return Math.floor(dt.getTime() / MS_PER_DAY);
}

export function addDays(base: Date, n: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + n);
  return d;
}

/** Iterate `count` calendar days starting at day number `startDay`. */
export function iterDays(startDay: number, count: number): Date[] {
  const base = new Date(startDay * MS_PER_DAY);
  return Array.from({ length: count }, (_, i) => addDays(base, i));
}

/** Slip in calendar days (positive = current is later than baseline). */
export function slipDays(current: string | null, baseline: string | null): number | null {
  if (!current || !baseline) return null;
  return toDay(current) - toDay(baseline);
}

/** "+4d" / "-2d"; null when there is no slip. */
export function fmtSlip(days: number | null): string | null {
  if (days === null || days === 0) return null;
  return days > 0 ? `+${days}d` : `${days}d`;
}

/** "slipped 4 days" / "ahead 2 days"; null when there is no slip. */
export function slipPhrase(days: number | null): string | null {
  if (days === null || days === 0) return null;
  const n = Math.abs(days);
  const unit = n === 1 ? "day" : "days";
  return days > 0 ? `slipped ${n} ${unit}` : `ahead ${n} ${unit}`;
}
