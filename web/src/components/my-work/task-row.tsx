"use client";

import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { cn } from "@/lib/cn";
import { EntityLink } from "@/components/ui/entity-link";

export interface MyTask {
  id: string;
  name: string;
  status: string;
  status_type: string;
  priority: string;
  due_date: string | null;
  project_id: string;
  project_name: string | null;
  reference_id?: string | null;
  isOverdue: boolean;
}

function statusTone(st: string) {
  if (st === "completed" || st === "canceled") return "success" as const;
  if (st === "started") return "info" as const;
  if (st === "unstarted") return "neutral" as const;
  return "neutral" as const;
}

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function TaskRow({ task }: { task: MyTask }) {
  return (
    <div className="flex flex-col gap-2 rounded-md px-3 py-2.5 text-sm transition-colors hover:bg-sunken sm:flex-row sm:items-center sm:gap-3 sm:py-2">
      {/* Name row — its own line so five trailing chips never squeeze it to
          a couple of characters (the same fix as my-tasks/task-list.tsx). */}
      <div className="flex min-w-0 items-center gap-3">
        {/* Overdue dot */}
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            task.isOverdue ? "bg-danger" : "bg-border-subtle",
          )}
          aria-hidden
        />

        {/* Name — deep-links to the task in the project */}
        <EntityLink
          kind="task"
          id={task.id}
          projectId={task.project_id}
          className="min-w-0 flex-1 font-medium"
        >
          {task.name}
        </EntityLink>
      </div>

      {/* Chips row — wraps on its own line on phones, flattened back into
          the single desktop row via sm:contents. */}
      <div className="flex flex-wrap items-center gap-2 pl-[1.125rem] sm:contents sm:pl-0">
        {/* Project chip */}
        {task.project_name && (
          <span className="shrink-0 rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
            {task.project_name}
          </span>
        )}

        {/* Priority */}
        <Severity level={task.priority} className="shrink-0" />

        {/* Status */}
        <Badge size="sm" tone={statusTone(task.status_type)} className="shrink-0">
          {task.status}
        </Badge>

        {/* Due date */}
        {task.due_date && (
          <span
            className={cn(
              "shrink-0 whitespace-nowrap font-mono text-xs tabular-nums",
              task.isOverdue ? "font-medium text-danger-ink" : "text-ink-muted",
            )}
          >
            {formatDate(task.due_date)}
            {task.isOverdue && (
              <span className="ml-1.5 rounded-full bg-danger/10 px-1 py-0.5 text-2xs text-danger-ink">
                overdue
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
