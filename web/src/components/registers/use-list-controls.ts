"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Declarative filter field config for <FilterBar> (L-08). Each field maps to
 * one or two URL query-string params so a filtered view is linkable and
 * survives reload (locked decision: URL-encoded state via useSearchParams).
 */
export type FilterFieldConfig =
  | { key: string; label: string; type: "text"; placeholder?: string }
  | { key: string; label: string; type: "select"; options: Array<{ value: string; label: string }> }
  | { key: string; label: string; type: "date-range"; fromKey: string; toKey: string };

export type SortDirection = "asc" | "desc";
export type SortState = { field: string; direction: SortDirection };

// ---------------------------------------------------------------------------
// Pure helpers — no React, no browser APIs. Kept separate from the hook below
// so URL-encoding round-trip behaviour is unit-testable without mounting a
// component (this repo has no jsdom/@testing-library — see
// lib/auth/use-require-session.ts for the same "hook wraps pure logic"
// pattern this file follows).
// ---------------------------------------------------------------------------

/** Every URL param key a field config touches (text/select: 1 key; date-range: 2). */
export function fieldParamKeys(fields: readonly FilterFieldConfig[]): string[] {
  const keys: string[] = [];
  for (const f of fields) {
    if (f.type === "date-range") keys.push(f.fromKey, f.toKey);
    else keys.push(f.key);
  }
  return keys;
}

/** Read the current filter values for a field config set out of a URLSearchParams. */
export function parseFilters(
  searchParams: URLSearchParams,
  fields: readonly FilterFieldConfig[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of fieldParamKeys(fields)) {
    const v = searchParams.get(key);
    if (v) out[key] = v;
  }
  return out;
}

/** Parse `?sort=field:asc|desc`. Malformed/missing → null (caller applies its own default). */
export function parseSortParam(raw: string | null): SortState | null {
  if (!raw) return null;
  const [field, direction] = raw.split(":");
  if (!field || (direction !== "asc" && direction !== "desc")) return null;
  return { field, direction };
}

export function buildSortParam(field: string, direction: SortDirection): string {
  return `${field}:${direction}`;
}

/** Parse the (1-based) page param, defaulting/clamping to >= 1. */
export function parsePageParam(raw: string | null): number {
  const n = parseInt(raw ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * Apply a set of param updates onto a URLSearchParams, returning a NEW
 * instance (pure — never mutates `base`). `null`/`""` deletes the key.
 * Any update other than a bare page change resets `page` back to 1 — an
 * edited filter/sort should never leave the user stranded on a now-invalid
 * page number.
 */
export function applyControlsUpdate(
  base: URLSearchParams,
  updates: Record<string, string | null>,
): URLSearchParams {
  const next = new URLSearchParams(base.toString());
  for (const [k, v] of Object.entries(updates)) {
    if (v === null || v === "") next.delete(k);
    else next.set(k, v);
  }
  const onlyPageChanged = Object.keys(updates).length === 1 && "page" in updates;
  if (!onlyPageChanged) next.delete("page");
  return next;
}

/** Clear every filter field + page + sort, preserving any other unrelated params. */
export function clearedParams(
  base: URLSearchParams,
  fields: readonly FilterFieldConfig[],
): URLSearchParams {
  const next = new URLSearchParams(base.toString());
  for (const key of fieldParamKeys(fields)) next.delete(key);
  next.delete("page");
  next.delete("sort");
  return next;
}

/**
 * Build the query string to send to the governed API (filters + sort + page).
 * `extra` (e.g. limit) is layered on last and wins on key collision.
 */
export function toApiQueryString(
  filters: Record<string, string>,
  sort: SortState | null,
  page: number,
  extra?: Record<string, string>,
): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) qs.set(k, v);
  if (sort) qs.set("sort", buildSortParam(sort.field, sort.direction));
  if (page > 1) qs.set("page", String(page));
  if (extra) for (const [k, v] of Object.entries(extra)) qs.set(k, v);
  return qs.toString();
}

// ---------------------------------------------------------------------------
// The hook — wires the pure helpers above to Next's URL state.
// ---------------------------------------------------------------------------

export function useListControls(fields: readonly FilterFieldConfig[]) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fieldKey = fields.map((f) => (f.type === "date-range" ? `${f.fromKey}|${f.toKey}` : f.key)).join(",");

  const filters = useMemo(
    () => parseFilters(searchParams, fields),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchParams, fieldKey],
  );
  const sort = useMemo(() => parseSortParam(searchParams.get("sort")), [searchParams]);
  const page = useMemo(() => parsePageParam(searchParams.get("page")), [searchParams]);
  const activeFilterCount = Object.keys(filters).length;

  const push = useCallback(
    (next: URLSearchParams) => {
      const qs = next.toString();
      router.push(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname],
  );

  const setFilter = useCallback(
    (key: string, value: string | null) => push(applyControlsUpdate(searchParams, { [key]: value })),
    [push, searchParams],
  );

  const setSort = useCallback(
    (field: string, direction: SortDirection) =>
      push(applyControlsUpdate(searchParams, { sort: buildSortParam(field, direction) })),
    [push, searchParams],
  );

  const setPage = useCallback(
    (p: number) => push(applyControlsUpdate(searchParams, { page: p > 1 ? String(p) : null })),
    [push, searchParams],
  );

  const clearFilters = useCallback(
    () => push(clearedParams(searchParams, fields)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [push, searchParams, fieldKey],
  );

  return { filters, sort, page, activeFilterCount, setFilter, setSort, setPage, clearFilters };
}
