"use client";

import { useState, useMemo } from "react";
import { CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/cn";
import { EntityLink } from "@/components/ui/entity-link";
import { useDateDisplayPref } from "@/lib/theme/use-appearance";
import { formatByPref, type DateDisplayPref } from "@/lib/format/dates";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectTask {
  id: string;
  name: string;
  status: string;
  status_type: string;
  priority: string | null;
  due_date: string | null;
  project_id: string;
  project_code: string | null;
  project_name: string;
  project_rag_status: string | null;
}

type Filter = "all" | "overdue" | "in_progress" | "to_do";

// ── Helpers ───────────────────────────────────────────────────────────────────

const TODAY = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
})();

const DUE_SOON_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

function isOverdue(due: string | null) {
  return !!due && new Date(due) < TODAY;
}

function isDueSoon(due: string | null) {
  if (!due) return false;
  const d = new Date(due);
  return d >= TODAY && d.getTime() - TODAY.getTime() <= DUE_SOON_MS;
}

function statusTone(st: string): "neutral" | "info" | "success" | "warning" | "danger" {
  if (st === "completed" || st === "canceled") return "success";
  if (st === "started") return "info";
  return "neutral";
}

function matchesFilter(task: ProjectTask, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "overdue") return isOverdue(task.due_date);
  if (filter === "in_progress") return task.status_type === "started";
  if (filter === "to_do") return task.status_type === "unstarted";
  return true;
}

// ── Task row ──────────────────────────────────────────────────────────────────

function TaskRow({ task, dateDisplayPref }: { task: ProjectTask; dateDisplayPref: DateDisplayPref }) {
  const overdue = isOverdue(task.due_date);
  const soon = !overdue && isDueSoon(task.due_date);
  const due = formatByPref(task.due_date, dateDisplayPref);

  return (
    <div className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors hover:bg-sunken">
      {/* urgency dot */}
      <span
        aria-hidden
        className={cn(
          "mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full",
          overdue ? "bg-danger" : soon ? "bg-warning" : "bg-border-subtle",
        )}
      />

      {/* name — deep-links to the task inspector in the project */}
      <EntityLink
        kind="task"
        id={task.id}
        projectId={task.project_id}
        className="min-w-0 flex-1 font-medium"
      >
        {task.name}
      </EntityLink>

      {/* priority */}
      {task.priority && (
        <Severity level={task.priority} className="shrink-0" />
      )}

      {/* status pill */}
      <Badge size="sm" tone={statusTone(task.status_type)} className="shrink-0 capitalize">
        {task.status}
      </Badge>

      {/* due date */}
      {task.due_date && (
        <span
          title={due.title}
          className={cn(
            "shrink-0 whitespace-nowrap font-mono text-xs tabular-nums",
            overdue ? "font-medium text-danger" : soon ? "text-warning" : "text-ink-muted",
          )}
        >
          {due.text}
          {overdue && (
            <span className="ml-1.5 rounded-full bg-danger/10 px-1 py-0.5 text-[10px] text-danger">
              overdue
            </span>
          )}
          {soon && !overdue && (
            <span className="ml-1.5 rounded-full bg-warning/10 px-1 py-0.5 text-[10px] text-warning">
              soon
            </span>
          )}
        </span>
      )}
    </div>
  );
}

// ── Filter pill ───────────────────────────────────────────────────────────────

function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-accent text-accent-ink"
          : "bg-sunken text-ink-secondary hover:bg-border-subtle",
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 font-mono text-[10px]",
          active ? "bg-accent-ink/20 text-accent-ink" : "bg-canvas text-ink-muted",
        )}
      >
        {count}
      </span>
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function TaskList({ tasks }: { tasks: ProjectTask[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const dateDisplayPref = useDateDisplayPref();

  // Derived counts for filter pills
  const counts = useMemo(
    () => ({
      all: tasks.length,
      overdue: tasks.filter((t) => isOverdue(t.due_date)).length,
      in_progress: tasks.filter((t) => t.status_type === "started").length,
      to_do: tasks.filter((t) => t.status_type === "unstarted").length,
    }),
    [tasks],
  );

  // Apply filter
  const filtered = useMemo(
    () => tasks.filter((t) => matchesFilter(t, filter)),
    [tasks, filter],
  );

  // Group by project
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { project_id: string; project_code: string | null; project_name: string; project_rag_status: string | null; tasks: ProjectTask[] }
    >();
    for (const t of filtered) {
      const existing = map.get(t.project_id);
      if (existing) {
        existing.tasks.push(t);
      } else {
        map.set(t.project_id, {
          project_id: t.project_id,
          project_code: t.project_code,
          project_name: t.project_name,
          project_rag_status: t.project_rag_status,
          tasks: [t],
        });
      }
    }
    return [...map.values()];
  }, [filtered]);

  // Empty state
  if (tasks.length === 0) {
    return (
      <EmptyState
        icon={<CheckCircle2 size={36} className="text-success" strokeWidth={1.5} />}
        purpose="No tasks assigned to you. Anything assigned to you across every project will show up here."
      />
    );
  }

  return (
    <div className="space-y-5">
      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2">
        <FilterPill label="All" count={counts.all} active={filter === "all"} onClick={() => setFilter("all")} />
        <FilterPill label="Overdue" count={counts.overdue} active={filter === "overdue"} onClick={() => setFilter("overdue")} />
        <FilterPill label="In progress" count={counts.in_progress} active={filter === "in_progress"} onClick={() => setFilter("in_progress")} />
        <FilterPill label="To do" count={counts.to_do} active={filter === "to_do"} onClick={() => setFilter("to_do")} />
      </div>

      {/* Grouped project sections */}
      {groups.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-muted">
          No tasks match this filter.
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.project_id} className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
            {/* Project header */}
            <div className="flex items-center gap-2 border-b border-border-subtle bg-sunken/50 px-4 py-3">
              {group.project_code && (
                <span className="font-mono text-xs text-ink-muted">{group.project_code}</span>
              )}
              <EntityLink
                kind="project"
                id={group.project_id}
                className="min-w-0 flex-1 truncate text-sm font-medium"
              >
                {group.project_name}
              </EntityLink>
              <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 font-mono text-xs tabular-nums text-ink-muted">
                {group.tasks.length}
              </span>
            </div>

            {/* Task rows */}
            <div className="p-2 space-y-0.5">
              {group.tasks.map((t) => (
                <TaskRow key={t.id} task={t} dateDisplayPref={dateDisplayPref} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
