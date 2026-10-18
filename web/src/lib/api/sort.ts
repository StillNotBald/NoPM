import { RuleError } from "@/lib/api/errors";

export type ParsedSort = { field: string; ascending: boolean };

/**
 * Parse a `sort=field:asc|desc` query param against a fixed whitelist of
 * sortable columns (L-10). Unknown fields or directions are rejected with a
 * 422 (RuleError) rather than silently falling back to a default — a caller
 * that asked for a specific sort should never silently get a different one.
 *
 * `raw` missing/empty → `fallback` (the route's default sort).
 */
export function parseSort(
  raw: string | null | undefined,
  whitelist: readonly string[],
  fallback: ParsedSort,
): ParsedSort {
  if (!raw) return fallback;

  const [field, dir] = raw.split(":");
  if (!field || !whitelist.includes(field)) {
    throw new RuleError(
      `Invalid sort field "${field ?? ""}". Must be one of: ${whitelist.join(", ")}`,
    );
  }
  if (dir !== "asc" && dir !== "desc") {
    throw new RuleError(`Invalid sort direction "${dir ?? ""}". Must be "asc" or "desc"`);
  }
  return { field, ascending: dir === "asc" };
}

/**
 * PostgREST `.order()` options for a parsed sort. Nulls always sort LAST
 * regardless of direction (nullsFirst: false for both asc and desc) — so an
 * unscheduled task never jumps to the top of a "due_date desc" sort.
 */
export function orderOptions(sort: ParsedSort): { ascending: boolean; nullsFirst: boolean } {
  return { ascending: sort.ascending, nullsFirst: false };
}

/** Minimal shape of a Supabase/PostgREST query-builder chain's `.order()` step. */
export type Orderable<Q> = { order: (field: string, opts: { ascending: boolean; nullsFirst: boolean }) => Q };

/** Apply a parsed sort onto a query-builder chain. Generic so it's mockable in tests. */
export function applySort<Q>(query: Q & Orderable<Q>, sort: ParsedSort): Q {
  return query.order(sort.field, orderOptions(sort));
}
