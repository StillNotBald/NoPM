/**
 * Saved-view config codec (L-05/09/11) — the URL state <-> `saved_views.config`
 * jsonb round trip, as a PURE lib with zero framework dependency (no React,
 * no Next navigation hooks — see components/registers/use-list-controls.ts
 * for the analogous "hook wraps pure logic" split this file mirrors, kept
 * fully separate here so it stays importable from both client components and
 * the API layer without pulling in a "use client" module).
 *
 * A saved view's config is register-agnostic: any URL query param that
 * isn't one of the reserved control keys (sort/page/limit/columns/groupBy)
 * is treated as an opaque filter key/value pair. This is what lets the same
 * codec serve /tasks, /risks, /issues, /clashes etc. without a per-register
 * field whitelist baked in here — each register's own FilterFieldConfig list
 * already owns that.
 */

export type ViewSort = { field: string; direction: "asc" | "desc" } | null;

export type SavedViewConfig = {
  filters: Record<string, string>;
  sort: ViewSort;
  columns: string[] | null; // null = caller's default column set
  groupBy: string | null;
};

/** URL param keys the codec treats as control state, never as opaque filters. */
const RESERVED_KEYS = new Set(["sort", "page", "limit", "columns", "groupBy", "view"]);

export function emptyConfig(): SavedViewConfig {
  return { filters: {}, sort: null, columns: null, groupBy: null };
}

export function parseSort(raw: string | null | undefined): ViewSort {
  if (!raw) return null;
  const [field, direction] = raw.split(":");
  if (!field || (direction !== "asc" && direction !== "desc")) return null;
  return { field, direction };
}

export function buildSortParam(sort: ViewSort): string | null {
  return sort ? `${sort.field}:${sort.direction}` : null;
}

/** URLSearchParams (or an equivalent iterable-of-entries) → SavedViewConfig. */
export function configFromSearchParams(searchParams: URLSearchParams): SavedViewConfig {
  const filters: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    if (RESERVED_KEYS.has(key) || !value) continue;
    filters[key] = value;
  }
  const columnsRaw = searchParams.get("columns");
  const groupBy = searchParams.get("groupBy") || null;
  return {
    filters,
    sort: parseSort(searchParams.get("sort")),
    columns: columnsRaw ? columnsRaw.split(",").filter(Boolean) : null,
    groupBy,
  };
}

/** SavedViewConfig → URLSearchParams, the inverse of configFromSearchParams. */
export function searchParamsFromConfig(config: SavedViewConfig): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(config.filters)) {
    if (value) sp.set(key, value);
  }
  const sortParam = buildSortParam(config.sort);
  if (sortParam) sp.set("sort", sortParam);
  if (config.columns && config.columns.length > 0) sp.set("columns", config.columns.join(","));
  if (config.groupBy) sp.set("groupBy", config.groupBy);
  return sp;
}

/**
 * Defensive decode of a config value read back out of the DB (jsonb, so it
 * arrives as `unknown` — could be `{}` from the column default, a
 * hand-edited row, or (in principle) a shape from a future schema version).
 * NEVER throws; an unrecognised shape falls back to emptyConfig() field by
 * field, the same "corrupt preference degrades to default, never blanks the
 * page" rule L-39 states explicitly for user_preferences and this file
 * applies just as literally to saved_views.config.
 */
export function decodeStoredConfig(raw: unknown): SavedViewConfig {
  if (!raw || typeof raw !== "object") return emptyConfig();
  const obj = raw as Record<string, unknown>;

  const filters: Record<string, string> = {};
  if (obj.filters && typeof obj.filters === "object") {
    for (const [key, value] of Object.entries(obj.filters as Record<string, unknown>)) {
      if (typeof value === "string" && value) filters[key] = value;
    }
  }

  let sort: ViewSort = null;
  if (obj.sort && typeof obj.sort === "object") {
    const s = obj.sort as Record<string, unknown>;
    if (typeof s.field === "string" && s.field && (s.direction === "asc" || s.direction === "desc")) {
      sort = { field: s.field, direction: s.direction };
    }
  }

  const columns =
    Array.isArray(obj.columns) && obj.columns.every((c) => typeof c === "string")
      ? (obj.columns as string[])
      : null;

  const groupBy = typeof obj.groupBy === "string" && obj.groupBy ? obj.groupBy : null;

  return { filters, sort, columns: columns && columns.length > 0 ? columns : null, groupBy };
}

/** Encode a SavedViewConfig for storage — a plain JSON-serialisable object. */
export function encodeConfigForStorage(config: SavedViewConfig): Record<string, unknown> {
  return {
    filters: config.filters,
    sort: config.sort,
    columns: config.columns,
    groupBy: config.groupBy,
  };
}
