"use client";

import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { useModal } from "@/components/ui/modal";
import { useInspector } from "@/components/layout/app-shell";
import { apiDelete } from "@/lib/api-client";
import { MilestoneForm } from "@/components/forms/milestone-form";
import { TaskForm } from "@/components/forms/task-form";
import type { Milestone, Task } from "@/components/tracking/activity-table";

// ─── Types ────────────────────────────────────────────────────────────────────

type BadgeTone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";

// ─── Badge helpers (mirrored from activity-table for self-containment) ────────

function milestoneStatusBadge(status: Milestone["status"]): {
  tone: BadgeTone;
  label: string;
} {
  switch (status) {
    case "completed":  return { tone: "success", label: "Completed" };
    case "on_track":   return { tone: "success", label: "On track" };
    case "at_risk":    return { tone: "warning", label: "At risk" };
    case "delayed":    return { tone: "danger",  label: "Delayed" };
    case "not_started":
    default:           return { tone: "info",    label: "Not started" };
  }
}

function taskStatusBadge(statusType: Task["status_type"]): {
  tone: BadgeTone;
  label: string;
} {
  switch (statusType) {
    case "completed": return { tone: "success", label: "Completed" };
    case "started":   return { tone: "info",    label: "In progress" };
    case "canceled":  return { tone: "neutral", label: "Canceled" };
    case "backlog":   return { tone: "neutral", label: "Backlog" };
    case "unstarted":
    default:          return { tone: "neutral", label: "To do" };
  }
}

// ─── Date formatting ──────────────────────────────────────────────────────────

function fmtDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ─── Shared UI pieces ─────────────────────────────────────────────────────────

/** iOS-style "grouped list" row: label left, value right, hairline divider. */
function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-4 border-b border-border-subtle py-2.5 last:border-b-0">
      <span className="shrink-0 text-xs font-medium text-ink-muted">{label}</span>
      <span className="text-right text-sm text-ink">{children}</span>
    </div>
  );
}

/** Slim progress bar with percentage label. */
function DetailProgress({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs text-ink-muted">
        <span>Progress</span>
        <span className="tabular-nums">{clamped}%</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-sunken">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300"
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}

// ─── TaskDetailPanel ──────────────────────────────────────────────────────────

export function TaskDetailPanel({
  task,
  milestones,
}: {
  task: Task;
  milestones: Milestone[];
}) {
  const modal = useModal();
  const inspector = useInspector();
  const router = useRouter();

  const statusInfo = taskStatusBadge(task.status_type);

  const parentMilestone = milestones.find((m) => m.id === task.milestone_id);

  async function handleDelete() {
    const confirmed = window.confirm(
      `Delete task "${task.name}"? This cannot be undone.`
    );
    if (!confirmed) return;
    await apiDelete(`/api/tasks/${task.id}`);
    router.refresh();
    inspector.close();
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Header name + status */}
      <div className="space-y-1.5">
        <p className="text-base font-semibold text-ink leading-snug">{task.name}</p>
        {task.description && (
          <p className="text-sm text-ink-secondary leading-relaxed">
            {task.description}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Badge tone={statusInfo.tone}>{statusInfo.label}</Badge>
          <Severity level={task.priority} />
        </div>
      </div>

      {/* Progress bar */}
      <div className="rounded-lg bg-sunken/50 px-3 py-3">
        <DetailProgress pct={task.completion_pct} />
      </div>

      {/* Grouped details */}
      <div className="rounded-lg border border-border-subtle bg-surface px-3">
        <DetailRow label="Milestone">
          {parentMilestone ? (
            <span className="text-ink">{parentMilestone.name}</span>
          ) : (
            <span className="text-ink-muted">None</span>
          )}
        </DetailRow>
        <DetailRow label="Start date">{fmtDate(task.start_date)}</DetailRow>
        <DetailRow label="Due date">{fmtDate(task.due_date)}</DetailRow>
        <DetailRow label="Assignee">
          {task.assignee_id ?? <span className="text-ink-muted">Unassigned</span>}
        </DetailRow>
      </div>

      {/* Footer actions */}
      <div className="flex flex-col gap-2 pt-1 sm:flex-row">
        <Button
          variant="secondary"
          size="sm"
          className="flex-1 h-11 sm:h-9"
          onClick={() =>
            modal.open(
              <TaskForm
                projectId={task.project_id}
                task={task}
                milestones={milestones}
              />,
              { title: "Edit Task", size: "lg" }
            )
          }
        >
          <Pencil size={13} className="mr-1.5" />
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-11 sm:h-9 text-danger hover:bg-danger/10 sm:flex-none"
          onClick={handleDelete}
        >
          <Trash2 size={13} className="mr-1.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}

// ─── MilestoneDetailPanel ─────────────────────────────────────────────────────

export function MilestoneDetailPanel({ milestone }: { milestone: Milestone }) {
  const modal = useModal();
  const inspector = useInspector();
  const router = useRouter();

  const statusInfo = milestoneStatusBadge(milestone.status);

  async function handleDelete() {
    const confirmed = window.confirm(
      `Delete milestone "${milestone.name}"? All tasks within it will be unlinked. This cannot be undone.`
    );
    if (!confirmed) return;
    await apiDelete(`/api/milestones/${milestone.id}`);
    router.refresh();
    inspector.close();
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Header name + status */}
      <div className="space-y-1.5">
        <p className="text-base font-semibold text-ink leading-snug">{milestone.name}</p>
        <div className="flex flex-wrap gap-1.5 pt-1">
          <Badge tone={statusInfo.tone}>{statusInfo.label}</Badge>
        </div>
      </div>

      {/* Progress bar */}
      <div className="rounded-lg bg-sunken/50 px-3 py-3">
        <DetailProgress pct={milestone.completion_pct} />
      </div>

      {/* Grouped details */}
      <div className="rounded-lg border border-border-subtle bg-surface px-3">
        <DetailRow label="Target date">{fmtDate(milestone.target_date)}</DetailRow>
        <DetailRow label="Owner">
          {milestone.owner_id ?? (
            <span className="text-ink-muted">Unassigned</span>
          )}
        </DetailRow>
      </div>

      {/* Footer actions */}
      <div className="flex flex-col gap-2 pt-1 sm:flex-row">
        <Button
          variant="secondary"
          size="sm"
          className="flex-1 h-11 sm:h-9"
          onClick={() =>
            modal.open(
              <MilestoneForm
                projectId={milestone.project_id}
                milestone={milestone}
              />,
              { title: "Edit Milestone" }
            )
          }
        >
          <Pencil size={13} className="mr-1.5" />
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-11 sm:h-9 text-danger hover:bg-danger/10 sm:flex-none"
          onClick={handleDelete}
        >
          <Trash2 size={13} className="mr-1.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}
