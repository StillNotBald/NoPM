"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
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

/**
 * How a filter write reaches the URL. Typing in a text filter writes
 * `{ replace: true }`: it would otherwise add one history entry per debounced
 * burst, and Back would step through search drafts instead of leaving the page.
 */
export type FilterChangeOptions = { replace?: boolean };

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

/** Text filters are typed into; every other control is a discrete choice worth a history entry. */
export function filterWritesReplaceHistory(field: FilterFieldConfig): boolean {
  return field.type === "text";
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
// Writes in flight. A control change is built on the params we most recently
// WROTE, not the ones last rendered: a debounced text commit can fire while an
// earlier select change is still navigating, and building it from the stale
// rendered params would silently drop that select. Pure so the sequencing is
// unit-testable.
// ---------------------------------------------------------------------------

/** How long a write we issued may stand in for the router's own params. */
export const PENDING_WINDOW_MS = 5000;

export interface PendingWrites {
  /** Query strings written but not yet seen echoed by the router, oldest first. */
  qs: string[];
  /** When the newest was written (ms). */
  at: number;
}

export function recordWrite(prev: PendingWrites | null, qs: string, now: number): PendingWrites {
  return { qs: [...(prev?.qs ?? []), qs], at: now };
}

/**
 * The router rendered `renderedQs`. If that is one of our writes, everything up
 * to and including it has landed; if it is none of them, an external navigation
 * (Back/Forward, a link) has superseded them all.
 */
export function settleWrites(prev: PendingWrites | null, renderedQs: string): PendingWrites | null {
  if (!prev) return null;
  const landed = prev.qs.indexOf(renderedQs);
  if (landed >= 0 && landed < prev.qs.length - 1) return { qs: prev.qs.slice(landed + 1), at: prev.at };
  return null;
}

/** The query string the next control change should be built on. */
export function baseQueryString(
  pending: PendingWrites | null,
  renderedQs: string,
  now: number,
  windowMs: number = PENDING_WINDOW_MS,
): string {
  if (pending && pending.qs.length > 0 && now - pending.at < windowMs) return pending.qs[pending.qs.length - 1];
  return renderedQs;
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

  // See "Writes in flight" above: control changes build on what we last wrote,
  // not on what the router last rendered.
  const writesRef = useRef<PendingWrites | null>(null);
  const renderedQs = searchParams.toString();
  useEffect(() => {
    writesRef.current = settleWrites(writesRef.current, renderedQs);
  }, [renderedQs]);

  const baseParams = useCallback(
    (): URLSearchParams => new URLSearchParams(baseQueryString(writesRef.current, renderedQs, Date.now())),
    [renderedQs],
  );

  const push = useCallback(
    (next: URLSearchParams, opts?: FilterChangeOptions) => {
      const qs = next.toString();
      writesRef.current = recordWrite(writesRef.current, qs, Date.now());
      const href = qs ? `${pathname}?${qs}` : pathname;
      if (opts?.replace) router.replace(href, { scroll: false });
      else router.push(href);
    },
    [router, pathname],
  );

  const setFilter = useCallback(
    (key: string, value: string | null, opts?: FilterChangeOptions) =>
      push(applyControlsUpdate(baseParams(), { [key]: value }), opts),
    [push, baseParams],
  );

  const setSort = useCallback(
    (field: string, direction: SortDirection) =>
      push(applyControlsUpdate(baseParams(), { sort: buildSortParam(field, direction) })),
    [push, baseParams],
  );

  const setPage = useCallback(
    (p: number) => push(applyControlsUpdate(baseParams(), { page: p > 1 ? String(p) : null })),
    [push, baseParams],
  );

  const clearFilters = useCallback(
    () => push(clearedParams(baseParams(), fields)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [push, baseParams, fieldKey],
  );

  return { filters, sort, page, activeFilterCount, setFilter, setSort, setPage, clearFilters };
}
