"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
import { entityHref } from "@/lib/nav/entity-href";
import { cn } from "@/lib/cn";

/**
 * Cross-project task register (L-04) — every task in the workspace, filtered
 * (L-08) and sorted (L-10) server-side via GET /api/tasks. Filter/sort/page
 * state is URL-encoded (linkable, survives reload); the Export CSV button
 * (L-27) carries the SAME query string so the file matches the screen.
 */

interface TaskRow {
  id: string;
  project_id: string;
  name: string;
  status_type: string;
  priority: string;
  due_date: string | null;
  completion_pct: number | null;
  assignee_id: string | null;
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

const SORTABLE_COLUMNS: Array<{ field: string; label: string }> = [
  { field: "name", label: "Task" },
  { field: "status_type", label: "Status" },
  { field: "priority", label: "Priority" },
  { field: "due_date", label: "Due" },
  { field: "completion_pct", label: "Done %" },
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

export default function TasksPage() {
  const { filters, sort, page, activeFilterCount, setFilter, setSort, setPage, clearFilters } =
    useListControls(FILTER_FIELDS);

  const apiQuery = useMemo(
    () => toApiQueryString(filters, sort, page, { limit: String(PAGE_SIZE) }),
    [filters, sort, page],
  );

  const [rows, setRows] = useState<TaskRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-5">
        <PageHeader
          title="Tasks"
          action={<ExportCsvButton href={`/api/export?entity=tasks&${apiQuery}`} />}
        />

        <FilterBar
          fields={FILTER_FIELDS}
          values={filters}
          onChange={setFilter}
          onClear={clearFilters}
          activeCount={activeFilterCount}
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
                  {SORTABLE_COLUMNS.map((col) => (
                    <th key={col.field} className="px-3 py-2 font-medium text-ink-secondary">
                      <button
                        type="button"
                        onClick={() => toggleSort(col.field)}
                        className={cn(
                          "inline-flex min-h-[44px] items-center gap-1 sm:min-h-0",
                          "hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 rounded",
                          sort?.field === col.field && "text-ink",
                        )}
                        aria-label={`Sort by ${col.label}`}
                      >
                        {col.label}
                        {sort?.field === col.field &&
                          (sort.direction === "asc" ? (
                            <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                          ) : (
                            <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                          ))}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {rows.map((task) => (
                  <tr key={task.id} className="hover:bg-sunken transition-colors duration-100">
                    <td className="px-3 py-2">
                      <Link
                        href={entityHref("task", { id: task.id, projectId: task.project_id })}
                        className="font-medium text-ink hover:text-accent"
                      >
                        {task.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={statusTone(task.status_type)}>{task.status_type}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={priorityTone(task.priority)}>{task.priority}</Badge>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-ink-secondary">
                      {task.due_date ?? "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-ink-secondary">
                      {task.completion_pct ?? 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
