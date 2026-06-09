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
    <div className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors hover:bg-sunken">
      {/* Overdue dot */}
      <span
        className={cn(
          "mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full",
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
            task.isOverdue ? "font-medium text-danger" : "text-ink-muted",
          )}
        >
          {formatDate(task.due_date)}
          {task.isOverdue && (
            <span className="ml-1.5 rounded-full bg-danger/10 px-1 py-0.5 text-[10px] text-danger">
              overdue
            </span>
          )}
        </span>
      )}
    </div>
  );
}
