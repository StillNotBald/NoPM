/**
 * Day-range helpers for GET /api/export?entity=audit (`from` / `to`).
 * Kept out of route.ts because a Next route module may only export handlers.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date (YYYY-MM-DD) or undefined — a malformed value is dropped, like the other lenient audit filters. */
export function parseExportDay(v: string | null): string | undefined {
  if (!v || !DAY_RE.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? undefined : v;
}

/** The UTC midnight after `day` — the exclusive upper bound that makes `to` inclusive of that whole day. */
export function dayAfter(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}
