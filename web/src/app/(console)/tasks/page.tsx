"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ExportCsvButton } from "@/components/export-csv-button";
import { FilterBar } from "@/components/registers/filter-bar";
import {
  useListControls,
  toApiQueryString,
  type FilterFieldConfig,
} from "@/components/registers/use-list-controls";
import { SavedViewsBar, type SavedView } from "@/components/registers/saved-views-bar";
import { GroupBySelect, type GroupByOption } from "@/components/registers/group-by-select";
import { ColumnChooser, type ColumnDef } from "@/components/registers/column-chooser";
import { AggregateFooter, type AggregateSpec } from "@/components/registers/aggregate-footer";
import {
  decodeStoredConfig,
  buildSortParam,
  type SavedViewConfig,
} from "@/lib/views/view-config";
import { useRegisterPreferences } from "@/lib/views/use-register-preferences";
import { apiGet } from "@/lib/api-client";
import { entityHref } from "@/lib/nav/entity-href";
import { cn } from "@/lib/cn";

/**
 * Cross-project task register (L-04) — every task in the workspace, filtered
 * (L-08) and sorted (L-10) server-side via GET /api/tasks. Filter/sort/page
 * state is URL-encoded (linkable, survives reload); the Export CSV button
 * (L-27) carries the SAME query string so the file matches the screen.
 *
 * This is also the reference implementation for saved views (L-05/06/07/41),
 * group-by (L-09), the column chooser (L-11) and the aggregate footer
 * (L-16) — other registers wire the same three components
 * (SavedViewsBar/GroupBySelect/ColumnChooser/AggregateFooter) against their
 * own filter/column set.
 */

const REGISTER = "tasks";
const COLUMNS_STORAGE_KEY = "nopm:columns:tasks";

interface TaskRow {
  id: string;
  project_id: string;
  name: string;
  status_type: string;
  priority: string;
  due_date: string | null;
  completion_pct: number | null;
  assignee_id: string | null;
  estimate_hours: number | null;
}

const FILTER_FIELDS: readonly FilterFieldConfig[] = [
  { key: "q", label: "Search", type: "text", placeholder: "Task name…" },
  {
    key: "status_type",
    label: "Status",
    type: "select",
    options: [
      { value: "backlog", label: "Backlog" },
      { value: "unstarted", label: "Unstarted" },
      { value: "started", label: "Started" },
      { value: "completed", label: "Completed" },
      { value: "canceled", label: "Canceled" },
    ],
  },
  {
    key: "priority",
    label: "Priority",
    type: "select",
    options: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "urgent", label: "Urgent" },
    ],
  },
  { key: "due", label: "Due between", type: "date-range", fromKey: "due_after", toKey: "due_before" },
];

// Only these fields are in TASK_SORT_FIELDS (src/app/api/tasks/_query.ts) —
// assignee/project/estimate columns below are visible but not sortable.
const SORTABLE_FIELDS = new Set(["name", "status_type", "priority", "due_date", "completion_pct"]);

const ALL_COLUMNS: readonly ColumnDef[] = [
  { key: "name", label: "Task" },
  { key: "status_type", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "due_date", label: "Due" },
  { key: "completion_pct", label: "Done %" },
  { key: "assignee_id", label: "Assignee" },
  { key: "project_id", label: "Project" },
  { key: "estimate_hours", label: "Estimate (h)" },
];

const DEFAULT_COLUMNS = ["name", "status_type", "priority", "due_date", "completion_pct"];

const GROUP_BY_OPTIONS: readonly GroupByOption[] = [
  { value: "status_type", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "assignee", label: "Assignee" },
  { value: "project", label: "Project" },
];

const PAGE_SIZE = 50;

function statusTone(status: string): "neutral" | "accent" | "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  if (status === "started") return "accent";
  if (status === "canceled") return "neutral";
  return "neutral";
}

function priorityTone(priority: string): "neutral" | "accent" | "success" | "warning" | "danger" {
  if (priority === "urgent") return "danger";
  if (priority === "high") return "warning";
  return "neutral";
}

function readStoredColumns(): string[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(COLUMNS_STORAGE_KEY);
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

export default function TasksPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeViewId = searchParams.get("view");

  const { filters, sort, page, activeFilterCount, setFilter, setSort, setPage, clearFilters } =
    useListControls(FILTER_FIELDS);

  const apiQuery = useMemo(
    () => toApiQueryString(filters, sort, page, { limit: String(PAGE_SIZE) }),
    [filters, sort, page],
  );

  const [columns, setColumns] = useState<string[]>(DEFAULT_COLUMNS);
  const [groupBy, setGroupBy] = useState<string | null>(null);

  // L-39 follow-through: the SAME per-user store appearance prefs use
  // (GET/PUT /api/me/preferences), scoped to this register. Additive over
  // the localStorage hydration below — when it resolves with a value for a
  // signed-in non-demo user, that value wins; until then (or for
  // anonymous/demo/token) localStorage keeps working exactly as before.
  const registerPrefs = useRegisterPreferences(REGISTER);

  const [rows, setRows] = useState<TaskRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [memberNameById, setMemberNameById] = useState<Map<string, string>>(new Map());
  const [projectNameById, setProjectNameById] = useState<Map<string, string>>(new Map());

  // Name maps for the assignee/project columns + group labels — best-effort,
  // capped at 100 (same page-size ceiling GET /api/resources and
  // GET /api/projects already default to); a workspace beyond that shows a
  // raw id for the overflow rather than failing the page.
  useEffect(() => {
    apiGet<Array<{ id: string; name: string }>>("/api/resources?limit=100")
      .then((list) => setMemberNameById(new Map((list ?? []).map((m) => [m.id, m.name]))))
      .catch(() => {});
    apiGet<Array<{ id: string; name: string }>>("/api/projects?limit=100")
      .then((list) => setProjectNameById(new Map((list ?? []).map((p) => [p.id, p.name]))))
      .catch(() => {});
  }, []);

  // Column persistence (L-11): while no saved view is active, the chooser's
  // selection lives in localStorage — hydrate once on mount, then write
  // back on every change. When a view IS active, its config.columns owns
  // the selection instead (see the activeViewId effect below).
  useEffect(() => {
    if (activeViewId) return;
    const stored = readStoredColumns();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- house pattern (see theme-toggle): one-time hydration from localStorage on mount, not a render-driven sync
    if (stored) setColumns(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeViewId) return;
    try {
      window.localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(columns));
    } catch {
      // best-effort only — a full/blocked localStorage never breaks the page
    }
  }, [columns, activeViewId]);

  // L-39: once the DB preferences fetch resolves, its value for THIS
  // register wins over whatever localStorage/the default just hydrated —
  // same "DB wins over cookie/device" precedence appearance prefs use. Only
  // applies when no saved view is active (a view's own config already wins,
  // same rule the localStorage effects above already follow).
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

  // Deep-link / reload support: ?view=<id> in the URL (set when a view is
  // applied, or pasted directly) re-fetches that view's config and applies
  // its columns + groupBy (filters/sort already live in the SAME URL, so
  // useListControls picks those up on its own). A view pointing at since-
  // deleted data just degrades to whatever filters are left — no 500 (L-05).
  useEffect(() => {
    if (!activeViewId) return;
    let cancelled = false;
    apiGet<SavedView>(`/api/saved-views/${activeViewId}`)
      .then((view) => {
        if (cancelled) return;
        const config = decodeStoredConfig(view.config);
        setColumns(config.columns && config.columns.length > 0 ? config.columns : DEFAULT_COLUMNS);
        setGroupBy(config.groupBy);
      })
      .catch(() => {
        // the referenced view is gone or no longer visible — leave whatever
        // filters/columns are already on screen alone, degrade gracefully.
      });
    return () => {
      cancelled = true;
    };
  }, [activeViewId]);

  useEffect(() => {
    // Raw fetch rather than apiGet: the list envelope's `total` is a SIBLING
    // of `data`, and apiGet unwraps to `data` alone — pagination needs both.
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- house pattern (see theme-toggle): reset fetch state when the query changes
    setLoading(true);
    setError(null);
    fetch(`/api/tasks?${apiQuery}`)
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as {
          data?: TaskRow[];
          total?: number;
          error?: string;
        };
        if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
        if (cancelled) return;
        setRows(json.data ?? []);
        setTotal(json.total ?? 0);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiQuery]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function toggleSort(field: string) {
    if (sort?.field === field) {
      setSort(field, sort.direction === "asc" ? "desc" : "asc");
    } else {
      setSort(field, "asc");
    }
  }

  function applyView(view: SavedView) {
    const config = decodeStoredConfig(view.config);
    const sp = new URLSearchParams();
    for (const [key, value] of Object.entries(config.filters)) {
      if (value) sp.set(key, value);
    }
    const sortParam = buildSortParam(config.sort);
    if (sortParam) sp.set("sort", sortParam);
    sp.set("view", view.id);
    setColumns(config.columns && config.columns.length > 0 ? config.columns : DEFAULT_COLUMNS);
    setGroupBy(config.groupBy);
    router.push(`${pathname}?${sp.toString()}`);
  }

  const currentConfig: SavedViewConfig = useMemo(
    () => ({ filters, sort, columns, groupBy }),
    [filters, sort, columns, groupBy],
  );

  const visibleColumns = ALL_COLUMNS.filter((c) => columns.includes(c.key));

  const groups = useMemo(() => buildGroups(rows, groupBy, memberNameById, projectNameById), [
    rows,
    groupBy,
    memberNameById,
    projectNameById,
  ]);

  const aggregates: AggregateSpec[] = [
    ...(columns.includes("completion_pct")
      ? [{ key: "completion_pct", label: "Avg done", kind: "avg" as const, values: rows.map((r) => r.completion_pct), format: (n: number) => `${Math.round(n)}%` }]
      : []),
    ...(columns.includes("estimate_hours")
      ? [{ key: "estimate_hours", label: "Est. hours", kind: "sum" as const, values: rows.map((r) => r.estimate_hours) }]
      : []),
  ];

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <PageHeader
          title="Tasks"
          action={<ExportCsvButton href={`/api/export?entity=tasks&${apiQuery}`} />}
        />

        <div className="flex flex-wrap items-end justify-between gap-3">
          <FilterBar
            fields={FILTER_FIELDS}
            values={filters}
            onChange={setFilter}
            onClear={clearFilters}
            activeCount={activeFilterCount}
          />
          <div className="flex items-end gap-2">
            <GroupBySelect
              options={GROUP_BY_OPTIONS}
              value={groupBy}
              onChange={(next) => {
                setGroupBy(next);
                // Only persist as the personal default while no saved view
                // is active — mirrors the columns/localStorage rule above.
                if (!activeViewId) registerPrefs.setGroupBy(next);
              }}
            />
            <ColumnChooser
              columns={ALL_COLUMNS}
              visible={columns}
              onChange={(next) => {
                setColumns(next);
                if (!activeViewId) registerPrefs.setColumns(next);
              }}
            />
          </div>
        </div>

        <SavedViewsBar
          register={REGISTER}
          currentConfig={currentConfig}
          activeViewId={activeViewId}
          onApply={applyView}
        />

        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/15 px-4 py-3 text-sm text-danger">
            Failed to load tasks: {error}
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 py-12 justify-center text-sm text-ink-muted">
            <Spinner size="sm" /> Loading tasks…
          </div>
        )}

        {!loading && !error && rows.length === 0 && (
          <EmptyState
            purpose={
              activeFilterCount > 0
                ? `No tasks match the ${activeFilterCount} active filter${activeFilterCount > 1 ? "s" : ""}.`
                : "Every task across every project lands here — one filterable, sortable register."
            }
            action={
              activeFilterCount > 0 ? (
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
            canWrite={activeFilterCount > 0}
          />
        )}

        {!loading && !error && rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-border-subtle">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle bg-sunken text-left">
                  {visibleColumns.map((col) => (
                    <th key={col.key} className="px-3 py-2 font-medium text-ink-secondary">
                      {SORTABLE_FIELDS.has(col.key) ? (
                        <button
                          type="button"
                          onClick={() => toggleSort(col.key)}
                          className={cn(
                            "inline-flex min-h-[44px] items-center gap-1 sm:min-h-0",
                            "hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 rounded",
                            sort?.field === col.key && "text-ink",
                          )}
                          aria-label={`Sort by ${col.label}`}
                        >
                          {col.label}
                          {sort?.field === col.key &&
                            (sort.direction === "asc" ? (
                              <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                            ) : (
                              <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                            ))}
                        </button>
                      ) : (
                        col.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {groups.map((group) => (
                  <GroupRows
                    key={group.key}
                    group={group}
                    columns={visibleColumns}
                    memberNameById={memberNameById}
                    projectNameById={projectNameById}
                  />
                ))}
              </tbody>
            </table>
            <AggregateFooter count={rows.length} aggregates={aggregates} />
          </div>
        )}

        {!loading && !error && total > PAGE_SIZE && (
          <div className="flex items-center justify-between text-sm text-ink-muted">
            <span>
              Page {page} of {totalPages} · {total} tasks
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Grouping (L-09) ─────────────────────────────────────────────────────────

type GroupBucket = { key: string; label: string; rows: TaskRow[] };

function buildGroups(
  rows: TaskRow[],
  groupBy: string | null,
  memberNameById: Map<string, string>,
  projectNameById: Map<string, string>,
): GroupBucket[] {
  if (!groupBy) return [{ key: "__all__", label: "", rows }];

  const order: string[] = [];
  const buckets = new Map<string, GroupBucket>();

  for (const row of rows) {
    let key: string;
    let label: string;
    switch (groupBy) {
      case "status_type":
        key = row.status_type;
        label = row.status_type;
        break;
      case "priority":
        key = row.priority;
        label = row.priority;
        break;
      case "assignee":
        key = row.assignee_id ?? "__none__";
        label = row.assignee_id ? (memberNameById.get(row.assignee_id) ?? row.assignee_id) : "No assignee";
        break;
      case "project":
        key = row.project_id ?? "__none__";
        label = row.project_id ? (projectNameById.get(row.project_id) ?? row.project_id) : "No project";
        break;
      default:
        key = "__all__";
        label = "";
    }
    if (!buckets.has(key)) {
      buckets.set(key, { key, label, rows: [] });
      order.push(key);
    }
    buckets.get(key)!.rows.push(row);
  }

  return order.map((key) => buckets.get(key)!);
}

function GroupRows({
  group,
  columns,
  memberNameById,
  projectNameById,
}: {
  group: GroupBucket;
  columns: readonly ColumnDef[];
  memberNameById: Map<string, string>;
  projectNameById: Map<string, string>;
}) {
  return (
    <>
      {group.label !== "" && (
        <tr className="bg-sunken/60">
          <td colSpan={columns.length} className="px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-ink-muted">
            {group.label} · {group.rows.length}
          </td>
        </tr>
      )}
      {group.rows.map((task) => (
        <tr key={task.id} className="hover:bg-sunken transition-colors duration-100">
          {columns.map((col) => (
            <td key={col.key} className="px-3 py-2">
              {renderCell(col.key, task, memberNameById, projectNameById)}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function renderCell(
  key: string,
  task: TaskRow,
  memberNameById: Map<string, string>,
  projectNameById: Map<string, string>,
): React.ReactNode {
  switch (key) {
    case "name":
      return (
        <Link
          href={entityHref("task", { id: task.id, projectId: task.project_id })}
          className="font-medium text-ink hover:text-accent"
        >
          {task.name}
        </Link>
      );
    case "status_type":
      return <Badge tone={statusTone(task.status_type)}>{task.status_type}</Badge>;
    case "priority":
      return <Badge tone={priorityTone(task.priority)}>{task.priority}</Badge>;
    case "due_date":
      return <span className="font-mono text-xs text-ink-secondary">{task.due_date ?? "—"}</span>;
    case "completion_pct":
      return <span className="font-mono text-xs text-ink-secondary">{task.completion_pct ?? 0}%</span>;
    case "assignee_id":
      return (
        <span className="text-xs text-ink-secondary">
          {task.assignee_id ? (memberNameById.get(task.assignee_id) ?? "Unknown member") : "No assignee"}
        </span>
      );
    case "project_id":
      return (
        <Link href={entityHref("project", { id: task.project_id })} className="text-xs text-ink-secondary hover:text-accent">
          {projectNameById.get(task.project_id) ?? "Unknown project"}
        </Link>
      );
    case "estimate_hours":
      return <span className="font-mono text-xs text-ink-secondary">{task.estimate_hours ?? "—"}</span>;
    default:
      return null;
  }
}
