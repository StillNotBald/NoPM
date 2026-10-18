"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { FilterBar } from "@/components/registers/filter-bar";
import {
  useListControls,
  toApiQueryString,
  fieldParamKeys,
  type FilterFieldConfig,
} from "@/components/registers/use-list-controls";
import { SavedViewsBar, type SavedView } from "@/components/registers/saved-views-bar";
import { GroupBySelect, type GroupByOption } from "@/components/registers/group-by-select";
import { ColumnChooser, type ColumnDef } from "@/components/registers/column-chooser";
import { FilterSheet } from "@/components/ui/filter-sheet";
import {
  decodeStoredConfig,
  buildSortParam,
  type SavedViewConfig,
} from "@/lib/views/view-config";
import { useRegisterPreferences } from "@/lib/views/use-register-preferences";
import { apiGet } from "@/lib/api-client";

/**
 * RegisterToolbar — the reusable list-control stack (audit item #1),
 * extracted from the /tasks reference implementation with no behaviour
 * change: inline search + collapsible FilterSheet (status/priority/dates),
 * group-by, column chooser, saved views, URL-encoded filter/sort/page state,
 * per-user column/group-by persistence (localStorage + /api/me/preferences),
 * and the query string shared with GET /api/export.
 *
 * Usage = two pieces, both driven by ONE config:
 *
 *   const controls = useRegisterToolbar({
 *     register: "risks",            // saved-views key + prefs key + localStorage key
 *     exportEntity: "risks",        // GET /api/export?entity=... (optional)
 *     searchField: { key: "q", label: "Search", type: "text", placeholder: "Risk title..." },
 *     sheetFields: [ ...FilterFieldConfig ],
 *     columns: ALL_COLUMNS,         // ColumnDef[] (key,label) the chooser offers
 *     defaultColumns: ["title", ...],
 *     groupByOptions: [ ... ],      // optional; omit to hide group-by
 *     pageSize: 50,
 *   });
 *   // header:  <ExportCsvButton href={controls.exportHref!} />
 *   // body:    <RegisterToolbar controls={controls} />
 *   // data:    fetch(`/api/risks?${controls.apiQuery}`), render controls.visibleColumns,
 *   //          group by controls.groupBy, sort via controls.sort / controls.toggleSort.
 *
 * Config objects (sheetFields, columns, ...) should be module-level constants
 * so their identity is stable across renders.
 */
export interface RegisterToolbarConfig {
  /** Saved-views register key (lowercase letters/underscores) — also keys prefs + localStorage columns. */
  register: string;
  /** GET /api/export entity; when set, `exportHref` is populated. */
  exportEntity?: string;
  /** Extra fixed params appended to the export href (e.g. { project_id }). */
  exportParams?: Record<string, string>;
  /** Always-visible inline search field (typically key "q"). */
  searchField?: FilterFieldConfig;
  /** Remaining filters; collapse into a FilterSheet below md. */
  sheetFields: readonly FilterFieldConfig[];
  /** Every column the chooser can show. */
  columns: readonly ColumnDef[];
  defaultColumns: readonly string[];
  groupByOptions?: readonly GroupByOption[];
  /**
   * Show Group by on phones too. Off by default: below md most registers render
   * a fixed card list that ignores grouping, and a control that does nothing
   * is worse than none. Column choice only drives the md+ table, so the
   * chooser is always hidden on phones.
   */
  phoneGroupBy?: boolean;
  /** Sent as `limit` in the API query. Default 50. */
  pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;

function readStoredColumns(storageKey: string): string[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((c) => typeof c === "string")) {
      return parsed as string[];
    }
  } catch {
    // corrupt localStorage value — fall back to the default, never blank the page
  }
  return null;
}

export function useRegisterToolbar(config: RegisterToolbarConfig) {
  const {
    register,
    exportEntity,
    exportParams,
    searchField,
    sheetFields,
    columns: allColumns,
    defaultColumns,
    groupByOptions,
  } = config;
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  // The key carries the register's DEFAULT columns: the persist effect below
  // writes the default back to localStorage on first mount, so a changed
  // default (Project joining Tasks, Strategy leaving Risks) would otherwise
  // never reach anyone who had already opened the page. A user's own choice
  // is also kept in the per-user preferences store, which still wins.
  const columnsStorageKey = `nopm:columns:${register}:${defaultColumns.join(".")}`;

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeViewId = searchParams.get("view");

  const filterFields = useMemo<readonly FilterFieldConfig[]>(
    () => (searchField ? [searchField, ...sheetFields] : sheetFields),
    [searchField, sheetFields],
  );

  const { filters, sort, page, activeFilterCount, setFilter, setSort, setPage, clearFilters } =
    useListControls(filterFields);

  const apiQuery = useMemo(
    () => toApiQueryString(filters, sort, page, { limit: String(pageSize) }),
    [filters, sort, page, pageSize],
  );

  const [columns, setColumns] = useState<string[]>([...defaultColumns]);
  const [groupBy, setGroupBy] = useState<string | null>(null);

  // L-39 follow-through: the SAME per-user store appearance prefs use
  // (GET/PUT /api/me/preferences), scoped to this register. Additive over the
  // localStorage hydration below — when it resolves with a value for a
  // signed-in non-demo user, that value wins.
  const registerPrefs = useRegisterPreferences(register);

  // Column persistence (L-11): while no saved view is active, the chooser's
  // selection lives in localStorage — hydrate once on mount, then write back
  // on every change. When a view IS active, its config.columns owns it.
  useEffect(() => {
    if (activeViewId) return;
    const stored = readStoredColumns(columnsStorageKey);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- house pattern (see theme-toggle): one-time hydration from localStorage on mount, not a render-driven sync
    if (stored) setColumns(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeViewId) return;
    try {
      window.localStorage.setItem(columnsStorageKey, JSON.stringify(columns));
    } catch {
      // best-effort only — a full/blocked localStorage never breaks the page
    }
  }, [columns, activeViewId, columnsStorageKey]);

  // L-39: once the DB preferences fetch resolves, its value for THIS
  // register wins over localStorage/the default. Only when no saved view is active.
  useEffect(() => {
    if (activeViewId || !registerPrefs.ready) return;
    if (registerPrefs.columns && registerPrefs.columns.length > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setColumns(registerPrefs.columns);
    }
    if (registerPrefs.groupBy !== null) {
      setGroupBy(registerPrefs.groupBy);
    }
  }, [activeViewId, registerPrefs.ready, registerPrefs.columns, registerPrefs.groupBy]);

  // Deep-link / reload support: ?view=<id> re-fetches that view's config and
  // applies its columns + groupBy (filters/sort already live in the URL). A
  // view pointing at since-deleted data degrades gracefully (L-05).
  useEffect(() => {
    if (!activeViewId) return;
    let cancelled = false;
    apiGet<SavedView>(`/api/saved-views/${activeViewId}`)
      .then((view) => {
        if (cancelled) return;
        const cfg = decodeStoredConfig(view.config);
        setColumns(cfg.columns && cfg.columns.length > 0 ? cfg.columns : [...defaultColumns]);
        setGroupBy(cfg.groupBy);
      })
      .catch(() => {
        // the referenced view is gone or no longer visible — leave the screen alone.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeViewId]);

  function applyView(view: SavedView) {
    const cfg = decodeStoredConfig(view.config);
    const sp = new URLSearchParams();
    for (const [key, value] of Object.entries(cfg.filters)) {
      if (value) sp.set(key, value);
    }
    const sortParam = buildSortParam(cfg.sort);
    if (sortParam) sp.set("sort", sortParam);
    sp.set("view", view.id);
    setColumns(cfg.columns && cfg.columns.length > 0 ? cfg.columns : [...defaultColumns]);
    setGroupBy(cfg.groupBy);
    router.push(`${pathname}?${sp.toString()}`);
  }

  const currentConfig: SavedViewConfig = useMemo(
    () => ({ filters, sort, columns, groupBy }),
    [filters, sort, columns, groupBy],
  );

  const visibleColumns = allColumns.filter((c) => columns.includes(c.key));

  // F4 — active count for just the sheet's fields (search stays outside it).
  const sheetActiveCount = fieldParamKeys(sheetFields).filter((k) => filters[k]).length;

  const exportHref = useMemo(() => {
    if (!exportEntity) return null;
    const extra = exportParams ? `&${new URLSearchParams(exportParams).toString()}` : "";
    return `/api/export?entity=${exportEntity}${extra}${apiQuery ? `&${apiQuery}` : ""}`;
  }, [exportEntity, exportParams, apiQuery]);

  function handleGroupByChange(next: string | null) {
    setGroupBy(next);
    // Only persist as the personal default while no saved view is active.
    if (!activeViewId) registerPrefs.setGroupBy(next);
  }

  function handleColumnsChange(next: string[]) {
    setColumns(next);
    if (!activeViewId) registerPrefs.setColumns(next);
  }

  /** Toggle sort: same field flips direction, a new field starts asc. */
  function toggleSort(field: string) {
    if (sort?.field === field) setSort(field, sort.direction === "asc" ? "desc" : "asc");
    else setSort(field, "asc");
  }

  return {
    config: { ...config, pageSize },
    searchField,
    sheetFields,
    allColumns,
    groupByOptions,
    // list-control state (URL-encoded)
    filters,
    sort,
    page,
    pageSize,
    activeFilterCount,
    setFilter,
    setSort,
    setPage,
    clearFilters,
    toggleSort,
    // derived
    apiQuery,
    exportHref,
    sheetActiveCount,
    // columns / grouping / views
    columns,
    visibleColumns,
    groupBy,
    activeViewId,
    currentConfig,
    applyView,
    handleGroupByChange,
    handleColumnsChange,
  };
}

export type RegisterToolbarControls = ReturnType<typeof useRegisterToolbar>;

/** Renders the filter row + group-by + column chooser + saved-views bar for a controls object. */
export function RegisterToolbar({ controls }: { controls: RegisterToolbarControls }) {
  const c = controls;
  const showGroupBy = c.groupByOptions && c.groupByOptions.length > 0;
  return (
    <div className="flex flex-wrap items-end gap-3">
      {c.searchField && (
        <FilterBar
          fields={[c.searchField]}
          values={c.filters}
          onChange={c.setFilter}
          onClear={c.clearFilters}
          activeCount={0}
        />
      )}
      {c.sheetFields.length > 0 && (
        <FilterSheet activeCount={c.sheetActiveCount} onClear={c.clearFilters}>
          <FilterBar
            fields={c.sheetFields}
            values={c.filters}
            onChange={c.setFilter}
            onClear={c.clearFilters}
            activeCount={c.sheetActiveCount}
          />
        </FilterSheet>
      )}
      <div className="ml-auto flex flex-wrap items-end gap-2">
        {showGroupBy && (
          <GroupBySelect
            options={c.groupByOptions!}
            value={c.groupBy}
            onChange={c.handleGroupByChange}
            className={c.config.phoneGroupBy ? undefined : "hidden md:flex"}
          />
        )}
        <ColumnChooser
          columns={c.allColumns}
          visible={c.columns}
          onChange={c.handleColumnsChange}
          className="hidden md:block"
        />
        <SavedViewsBar
          register={c.config.register}
          currentConfig={c.currentConfig}
          activeViewId={c.activeViewId}
          onApply={c.applyView}
        />
      </div>
    </div>
  );
}
