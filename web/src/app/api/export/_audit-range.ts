/**
 * Day-range helpers for GET /api/export (`from` / `to` / `on`, every entity).
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

/** `on=updated` filters on updated_at; anything else (or absent) filters on created_at. */
export type ExportRangeOn = "created" | "updated";

export type ExportRange = { from?: string; to?: string; on: ExportRangeOn };

/**
 * `from` / `to` (UTC calendar days, inclusive) and `on` for EVERY entity (M3).
 * Same leniency as the audit filters: a malformed day or an unknown `on` is
 * dropped rather than failing a download that has no per-field error channel.
 */
export function parseExportRange(sp: URLSearchParams): ExportRange {
  return {
    from: parseExportDay(sp.get("from")),
    to: parseExportDay(sp.get("to")),
    on: sp.get("on") === "updated" ? "updated" : "created",
  };
}

/**
 * The column a range filters on. `on=updated` only applies to entities that
 * have an updated_at; every other entity silently keeps its creation column
 * (`linkedAt` for connector identities, which have no created_at).
 */
export function rangeColumn(
  on: ExportRangeOn,
  opts: { hasUpdatedAt: boolean; createdColumn?: string },
): string {
  if (on === "updated" && opts.hasUpdatedAt) return "updated_at";
  return opts.createdColumn ?? "created_at";
}

type RangeQuery = { gte(c: string, v: string): RangeQuery; lt(c: string, v: string): RangeQuery };

/**
 * Applies the inclusive day range to any Supabase query builder. Typed loosely
 * on purpose: the generic builders blow TypeScript's instantiation depth
 * (TS2589) when composed, the same reason the fetch functions stay inline.
 */
export function applyExportRange<T>(query: T, range: ExportRange, column: string): T {
  let q = query as unknown as RangeQuery;
  if (range.from !== undefined) q = q.gte(column, `${range.from}T00:00:00Z`);
  if (range.to !== undefined) q = q.lt(column, dayAfter(range.to));
  return q as unknown as T;
}
