"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { THead, TH, TR, TD } from "@/components/ui/data-table";
import { ScrollTable } from "@/components/registers/scroll-table";
import { ExportCsvButton } from "@/components/export-csv-button";
import { type FilterFieldConfig } from "@/components/registers/use-list-controls";
import { useRegisterToolbar, RegisterToolbar } from "@/components/registers/register-toolbar";
import { type GroupByOption } from "@/components/registers/group-by-select";
import { type ColumnDef } from "@/components/registers/column-chooser";
import { ALL_COLUMNS, DEFAULT_COLUMNS, NUMERIC_COLUMNS, SORTABLE_FIELDS } from "./_columns";
import { AggregateFooter, type AggregateSpec } from "@/components/registers/aggregate-footer";
import { DataList, type DataListColumn } from "@/components/ui/data-list";
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

// F4 — search stays inline; status/priority/due collapse into a FilterSheet
// below md so the register's first row isn't ~1,400px below the fold.
const SEARCH_FIELD: FilterFieldConfig = { key: "q", label: "Search", type: "text", placeholder: "Task name…" };

const SHEET_FIELDS: readonly FilterFieldConfig[] = [
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

const GROUP_BY_OPTIONS: readonly GroupByOption[] = [
  { value: "status_type", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "assignee", label: "Assignee" },
  { value: "project", label: "Project" },
];

const PAGE_SIZE = 50;

// In progress is the info hue; the brand accent never marks status (DESIGN.md).
function statusTone(status: string): "neutral" | "info" | "success" | "warning" | "danger" {
  if (status === "completed") return "success";
  if (status === "started") return "info";
  return "neutral";
}

function priorityTone(priority: string): "neutral" | "accent" | "success" | "warning" | "danger" {
  if (priority === "urgent") return "danger";
  if (priority === "high") return "warning";
  return "neutral";
}

export default function TasksPage() {
  const controls = useRegisterToolbar({
    register: REGISTER,
    exportEntity: "tasks",
    searchField: SEARCH_FIELD,
    sheetFields: SHEET_FIELDS,
    columns: ALL_COLUMNS,
    defaultColumns: DEFAULT_COLUMNS,
    groupByOptions: GROUP_BY_OPTIONS,
    pageSize: PAGE_SIZE,
  });
  const { sort, page, activeFilterCount, setPage, clearFilters, apiQuery, columns, groupBy, visibleColumns, toggleSort } =
    controls;

  const [rows, setRows] = useState<TaskRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  // True once any response (or failure) has landed. Until then there is
  // nothing to keep on screen, so a spinner stands in; afterwards a refetch
  // dims the rows it will replace instead of unmounting them (typing in the
  // search box would otherwise blank the table, with its scroll position and
  // focus context, on every query).
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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
        if (!cancelled) {
          setLoading(false);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiQuery, reloadKey]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const groups = useMemo(() => buildGroups(rows, groupBy, memberNameById, projectNameById), [
    rows,
    groupBy,
    memberNameById,
    projectNameById,
  ]);

  // F5 — below md: cards, title/status/priority/project/due. Ungrouped
  // (DataList has no grouping concept); the desktop table keeps grouping,
  // sort, and the column chooser.
  const mobileColumns: DataListColumn<TaskRow>[] = [
    { key: "name", header: "Task", cell: (t) => t.name, primary: true },
    {
      key: "status_type",
      header: "Status",
      cell: (t) => <Badge tone={statusTone(t.status_type)}>{t.status_type}</Badge>,
      badge: true,
    },
    {
      key: "priority",
      header: "Priority",
      cell: (t) => <Badge tone={priorityTone(t.priority)}>{t.priority}</Badge>,
      badge: true,
    },
    {
      key: "project_id",
      header: "Project",
      cell: (t) => projectNameById.get(t.project_id) ?? "Unknown project",
    },
    { key: "due_date", header: "Due", cell: (t) => t.due_date ?? "—" },
  ];

  const aggregates: AggregateSpec[] = [
    ...(columns.includes("completion_pct")
      ? [{ key: "completion_pct", label: "Avg done", kind: "avg" as const, values: rows.map((r) => r.completion_pct), format: (n: number) => `${Math.round(n)}%` }]
      : []),
    ...(columns.includes("estimate_hours")
      ? [{ key: "estimate_hours", label: "Est. hours", kind: "sum" as const, values: rows.map((r) => r.estimate_hours) }]
      : []),
  ];

  const showTable = loaded && !error && rows.length > 0;

  return (
    <PageContainer width="wide" className="space-y-5">
      <PageHeader
        title="Tasks"
        action={<ExportCsvButton href={controls.exportHref ?? "/api/export?entity=tasks"} />}
      />

      <RegisterToolbar controls={controls} />

      {/* Announces the result of each (re)fetch without moving focus. */}
      <p role="status" aria-live="polite" className="sr-only">
        {loading ? "Loading tasks…" : error ? "" : `${total} task${total === 1 ? "" : "s"}`}
      </p>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger/15 px-4 py-3 text-sm text-danger-ink"
        >
          <span>Failed to load tasks: {error}</span>
          <Button variant="secondary" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
            Retry
          </Button>
        </div>
      )}

      {!loaded && (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-muted">
          <Spinner size="sm" /> Loading tasks…
        </div>
      )}

      {loaded && !error && rows.length === 0 && (
        <div aria-busy={loading} className={cn(loading && "opacity-60 transition-opacity")}>
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
        </div>
      )}

      {showTable && (
        <div aria-busy={loading} className={cn(loading && "opacity-60 transition-opacity")}>
          <div className="hidden md:block">
            <ScrollTable label="Task register" footer={<AggregateFooter count={rows.length} aggregates={aggregates} />}>
              <THead>
                <TR>
                  {visibleColumns.map((col) => {
                    const active = sort?.field === col.key;
                    return (
                      <TH
                        key={col.key}
                        align={NUMERIC_COLUMNS.has(col.key) ? "right" : "left"}
                        aria-sort={active ? (sort!.direction === "asc" ? "ascending" : "descending") : undefined}
                      >
                        {SORTABLE_FIELDS.has(col.key) ? (
                          <button
                            type="button"
                            onClick={() => toggleSort(col.key)}
                            className={cn(
                              "focus-ring inline-flex items-center gap-1 rounded uppercase hover:text-ink",
                              active && "text-ink",
                            )}
                            aria-label={`Sort by ${col.label}`}
                          >
                            {col.label}
                            {active &&
                              (sort!.direction === "asc" ? (
                                <ArrowUp className="h-3 w-3" aria-hidden />
                              ) : (
                                <ArrowDown className="h-3 w-3" aria-hidden />
                              ))}
                          </button>
                        ) : (
                          col.label
                        )}
                      </TH>
                    );
                  })}
                </TR>
              </THead>
              <tbody>
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
            </ScrollTable>
          </div>

          <div className="rounded-lg border border-border-subtle md:hidden">
            <DataList
              columns={mobileColumns}
              rows={rows}
              rowKey={(t) => t.id}
              href={(t) => entityHref("task", { id: t.id, projectId: t.project_id })}
            />
          </div>
        </div>
      )}

      {loaded && !error && total > PAGE_SIZE && (
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
    </PageContainer>
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
        <TR className="bg-well/60">
          <TD colSpan={columns.length} className="text-xs font-medium uppercase tracking-wide text-ink-muted">
            {group.label} · {group.rows.length}
          </TD>
        </TR>
      )}
      {group.rows.map((task) => (
        <TR key={task.id} className="transition-colors duration-100 hover:bg-well">
          {columns.map((col) => (
            <TD
              key={col.key}
              align={NUMERIC_COLUMNS.has(col.key) ? "right" : "left"}
              numeric={NUMERIC_COLUMNS.has(col.key)}
              className="whitespace-nowrap"
            >
              {renderCell(col.key, task, memberNameById, projectNameById)}
            </TD>
          ))}
        </TR>
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
          title={task.name}
          className="focus-ring block max-w-[22rem] truncate rounded font-medium text-ink hover:text-accent"
        >
          {task.name}
        </Link>
      );
    case "status_type":
      return <Badge tone={statusTone(task.status_type)}>{task.status_type}</Badge>;
    case "priority":
      return <Badge tone={priorityTone(task.priority)}>{task.priority}</Badge>;
    case "due_date":
      return <span className="font-mono text-xs tabular-nums text-ink-secondary">{task.due_date ?? "—"}</span>;
    case "completion_pct":
      return <span className="text-xs text-ink-secondary">{task.completion_pct ?? 0}%</span>;
    case "assignee_id":
      return (
        <span className="text-xs text-ink-secondary">
          {task.assignee_id ? (memberNameById.get(task.assignee_id) ?? "Unknown member") : "No assignee"}
        </span>
      );
    case "project_id": {
      const name = projectNameById.get(task.project_id) ?? "Unknown project";
      return (
        <Link
          href={entityHref("project", { id: task.project_id })}
          title={name}
          className="focus-ring block max-w-[13rem] truncate rounded text-xs text-ink-secondary hover:text-accent"
        >
          {name}
        </Link>
      );
    }
    case "estimate_hours":
      return <span className="text-xs text-ink-secondary">{task.estimate_hours ?? "—"}</span>;
    default:
      return null;
  }
}
