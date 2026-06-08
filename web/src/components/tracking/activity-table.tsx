"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  ChevronDown,
  Diamond,
  Plus,
  Pencil,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { useModal } from "@/components/ui/modal";
import { apiDelete } from "@/lib/api-client";
import { MilestoneForm } from "@/components/forms/milestone-form";
import { TaskForm } from "@/components/forms/task-form";

// ─── Data shapes ────────────────────────────────────────────────────────────

export interface Milestone {
  id: string;
  project_id: string;
  name: string;
  target_date: string | null;
  status: "not_started" | "on_track" | "at_risk" | "delayed" | "completed";
  completion_pct: number;
  owner_id: string | null;
  sort_order: number;
}

export interface Task {
  id: string;
  project_id: string;
  milestone_id: string | null;
  name: string;
  description: string | null;
  status: string;
  status_type: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  priority: "low" | "medium" | "high" | "urgent";
  start_date: string | null;
  due_date: string | null;
  completion_pct: number;
  sort_order: number;
  assignee_id: string | null;
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface ActivityTableProps {
  projectId: string;
  milestones: Milestone[];
  tasks: Task[];
  isLocked: boolean;
}

// ─── Badge helpers ────────────────────────────────────────────────────────────

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

function milestoneStatusBadge(status: Milestone["status"]): {
  tone: BadgeTone;
  label: string;
} {
  switch (status) {
    case "completed":
      return { tone: "success", label: "Completed" };
    case "on_track":
      return { tone: "accent", label: "On track" };
    case "at_risk":
      return { tone: "warning", label: "At risk" };
    case "delayed":
      return { tone: "danger", label: "Delayed" };
    case "not_started":
    default:
      return { tone: "neutral", label: "Not started" };
  }
}

function taskStatusBadge(statusType: Task["status_type"]): {
  tone: BadgeTone;
  label: string;
} {
  switch (statusType) {
    case "completed":
      return { tone: "success", label: "Completed" };
    case "started":
      return { tone: "accent", label: "In progress" };
    case "canceled":
      return { tone: "neutral", label: "Canceled" };
    case "backlog":
      return { tone: "neutral", label: "Backlog" };
    case "unstarted":
    default:
      return { tone: "neutral", label: "To do" };
  }
}

function priorityBadge(priority: Task["priority"]): {
  tone: BadgeTone;
  label: string;
} {
  switch (priority) {
    case "urgent":
      return { tone: "danger", label: "Urgent" };
    case "high":
      return { tone: "warning", label: "High" };
    case "medium":
      return { tone: "accent", label: "Medium" };
    case "low":
    default:
      return { tone: "neutral", label: "Low" };
  }
}

// ─── Mini progress bar ────────────────────────────────────────────────────────

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-sunken">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-ink-muted">{clamped}%</span>
    </div>
  );
}

// ─── Date formatting ──────────────────────────────────────────────────────────

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const date = new Date(d);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtDateRange(start: string | null, end: string | null): string {
  if (!start && !end) return "—";
  if (!start) return `Until ${fmtDate(end)}`;
  if (!end) return `From ${fmtDate(start)}`;
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}

// ─── Confirm-delete helper ────────────────────────────────────────────────────

function useConfirmDelete() {
  const router = useRouter();
  return async (url: string, label: string) => {
    const confirmed = window.confirm(`Delete "${label}"? This cannot be undone.`);
    if (!confirmed) return;
    await apiDelete(url);
    router.refresh();
  };
}

// ─── Milestone row ─────────────────────────────────────────────────────────────

function MilestoneRow({
  milestone,
  wbs,
  isExpanded,
  onToggle,
  projectId,
  milestones,
  onDelete,
}: {
  milestone: Milestone;
  wbs: string;
  isExpanded: boolean;
  onToggle: () => void;
  projectId: string;
  milestones: Milestone[];
  onDelete: (id: string, name: string) => void;
}) {
  const modal = useModal();
  const statusInfo = milestoneStatusBadge(milestone.status);

  return (
    <tr
      className="group border-t border-border-subtle hover:bg-sunken/50 transition-colors"
      role="row"
    >
      {/* WBS */}
      <td className="w-14 py-2.5 pl-4 pr-2">
        <span className="font-mono text-xs text-ink-muted">{wbs}</span>
      </td>

      {/* Expand / name */}
      <td className="py-2.5 pr-3" colSpan={2}>
        <div className="flex items-center gap-1.5">
          <button
            onClick={onToggle}
            className="shrink-0 rounded p-0.5 text-ink-muted hover:bg-sunken hover:text-ink"
            aria-label={isExpanded ? "Collapse" : "Expand"}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <Diamond size={13} className="shrink-0 text-accent" />
          <span className="font-medium text-sm text-ink">{milestone.name}</span>
        </div>
      </td>

      {/* Dates */}
      <td className="py-2.5 pr-4 text-xs text-ink-secondary">
        {fmtDate(milestone.target_date)}
      </td>

      {/* Priority — not applicable for milestones */}
      <td className="py-2.5 pr-4" />

      {/* Status */}
      <td className="py-2.5 pr-4">
        <Badge tone={statusInfo.tone}>{statusInfo.label}</Badge>
      </td>

      {/* Progress */}
      <td className="py-2.5 pr-4">
        <ProgressBar pct={milestone.completion_pct} />
      </td>

      {/* Row actions */}
      <td className="w-28 py-2.5 pr-4">
        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              modal.open(
                <TaskForm
                  projectId={projectId}
                  milestoneId={milestone.id}
                  milestones={milestones}
                />,
                { title: "New Task", size: "lg" }
              )
            }
            className="h-7 gap-1 px-2 text-xs"
          >
            <Plus size={12} />
            Task
          </Button>
          <button
            onClick={() =>
              modal.open(
                <MilestoneForm projectId={projectId} milestone={milestone} />,
                { title: "Edit Milestone" }
              )
            }
            className="grid h-7 w-7 place-items-center rounded text-ink-muted hover:bg-sunken hover:text-ink"
            aria-label="Edit milestone"
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={() => onDelete(milestone.id, milestone.name)}
            className="grid h-7 w-7 place-items-center rounded text-ink-muted hover:bg-sunken hover:text-danger"
            aria-label="Delete milestone"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── Task row ─────────────────────────────────────────────────────────────────

function TaskRow({
  task,
  wbs,
  isLast,
  projectId,
  milestones,
  onDelete,
}: {
  task: Task;
  wbs: string;
  isLast: boolean;
  projectId: string;
  milestones: Milestone[];
  onDelete: (id: string, name: string) => void;
}) {
  const modal = useModal();
  const statusInfo = taskStatusBadge(task.status_type);
  const prioInfo = priorityBadge(task.priority);

  return (
    <tr
      className="group border-t border-border-subtle hover:bg-sunken/50 transition-colors"
      role="row"
    >
      {/* WBS */}
      <td className="w-14 py-2 pl-4 pr-2">
        <span className="font-mono text-xs text-ink-muted">{wbs}</span>
      </td>

      {/* Tree connector + name */}
      <td className="py-2 pr-1 w-5">
        <div className="relative flex h-full items-start justify-center">
          <div
            className={cn(
              "absolute left-1/2 w-px -translate-x-1/2 bg-border-subtle",
              isLast ? "h-1/2 top-0" : "h-full"
            )}
          />
          <div className="relative mt-[10px] h-px w-2.5 bg-border-subtle" />
        </div>
      </td>
      <td className="py-2 pr-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-ink">{task.name}</span>
          {task.assignee_id && (
            <span className="text-xs text-ink-muted">
              Assignee: {task.assignee_id}
            </span>
          )}
        </div>
      </td>

      {/* Date range */}
      <td className="py-2 pr-4 text-xs text-ink-secondary whitespace-nowrap">
        {fmtDateRange(task.start_date, task.due_date)}
      </td>

      {/* Priority */}
      <td className="py-2 pr-4">
        <Badge tone={prioInfo.tone}>{prioInfo.label}</Badge>
      </td>

      {/* Status */}
      <td className="py-2 pr-4">
        <Badge tone={statusInfo.tone}>{statusInfo.label}</Badge>
      </td>

      {/* Progress */}
      <td className="py-2 pr-4">
        <ProgressBar pct={task.completion_pct} />
      </td>

      {/* Row actions */}
      <td className="w-28 py-2 pr-4">
        <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() =>
              modal.open(
                <TaskForm
                  projectId={projectId}
                  task={task}
                  milestones={milestones}
                />,
                { title: "Edit Task", size: "lg" }
              )
            }
            className="grid h-7 w-7 place-items-center rounded text-ink-muted hover:bg-sunken hover:text-ink"
            aria-label="Edit task"
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={() => onDelete(task.id, task.name)}
            className="grid h-7 w-7 place-items-center rounded text-ink-muted hover:bg-sunken hover:text-danger"
            aria-label="Delete task"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ActivityTable({
  projectId,
  milestones,
  tasks,
  isLocked,
}: ActivityTableProps) {
  const modal = useModal();
  const router = useRouter();

  // Default: all milestones expanded
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(milestones.map((m) => m.id).concat(["__standalone__"]))
  );

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Confirm-delete handlers
  const confirmDeleteMilestone = async (id: string, name: string) => {
    const confirmed = window.confirm(
      `Delete milestone "${name}"? All tasks within it will be unlinked. This cannot be undone.`
    );
    if (!confirmed) return;
    await apiDelete(`/api/milestones/${id}`);
    router.refresh();
  };

  const confirmDeleteTask = async (id: string, name: string) => {
    const confirmed = window.confirm(
      `Delete task "${name}"? This cannot be undone.`
    );
    if (!confirmed) return;
    await apiDelete(`/api/tasks/${id}`);
    router.refresh();
  };

  // Group tasks by milestone_id
  const tasksByMilestone = new Map<string | null, Task[]>();
  for (const task of tasks) {
    const key = task.milestone_id ?? null;
    const group = tasksByMilestone.get(key) ?? [];
    group.push(task);
    tasksByMilestone.set(key, group);
  }

  // Sort milestones by sort_order
  const sortedMilestones = [...milestones].sort(
    (a, b) => a.sort_order - b.sort_order
  );

  // Standalone tasks (no milestone)
  const standaloneTasks = (tasksByMilestone.get(null) ?? []).sort(
    (a, b) => a.sort_order - b.sort_order
  );

  const hasMilestones = sortedMilestones.length > 0;
  const hasStandalone = standaloneTasks.length > 0;
  const isEmpty = !hasMilestones && !hasStandalone;

  // ── Render rows ──────────────────────────────────────────────────────────

  const rows: React.ReactNode[] = [];

  sortedMilestones.forEach((milestone, mIdx) => {
    const mWbs = String(mIdx + 1);
    const isExpanded = expandedIds.has(milestone.id);
    const mTasks = (tasksByMilestone.get(milestone.id) ?? []).sort(
      (a, b) => a.sort_order - b.sort_order
    );

    rows.push(
      <MilestoneRow
        key={`m-${milestone.id}`}
        milestone={milestone}
        wbs={mWbs}
        isExpanded={isExpanded}
        onToggle={() => toggleExpand(milestone.id)}
        projectId={projectId}
        milestones={sortedMilestones}
        onDelete={confirmDeleteMilestone}
      />
    );

    if (isExpanded) {
      mTasks.forEach((task, tIdx) => {
        rows.push(
          <TaskRow
            key={`t-${task.id}`}
            task={task}
            wbs={`${mWbs}.${tIdx + 1}`}
            isLast={tIdx === mTasks.length - 1}
            projectId={projectId}
            milestones={sortedMilestones}
            onDelete={confirmDeleteTask}
          />
        );
      });
    }
  });

  // Standalone group
  if (hasStandalone) {
    const isExpanded = expandedIds.has("__standalone__");
    const standaloneWbs = String(sortedMilestones.length + 1);

    rows.push(
      <tr
        key="standalone-header"
        className="group border-t border-border-subtle hover:bg-sunken/50 transition-colors"
      >
        <td className="w-14 py-2.5 pl-4 pr-2">
          <span className="font-mono text-xs text-ink-muted">{standaloneWbs}</span>
        </td>
        <td className="py-2.5 pr-3" colSpan={2}>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => toggleExpand("__standalone__")}
              className="shrink-0 rounded p-0.5 text-ink-muted hover:bg-sunken hover:text-ink"
              aria-label={isExpanded ? "Collapse" : "Expand"}
            >
              {isExpanded ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
            </button>
            <span className="font-medium text-sm text-ink-secondary">
              Standalone
            </span>
            <Badge tone="neutral">{standaloneTasks.length}</Badge>
          </div>
        </td>
        <td colSpan={5} />
      </tr>
    );

    if (isExpanded) {
      standaloneTasks.forEach((task, tIdx) => {
        rows.push(
          <TaskRow
            key={`st-${task.id}`}
            task={task}
            wbs={`${standaloneWbs}.${tIdx + 1}`}
            isLast={tIdx === standaloneTasks.length - 1}
            projectId={projectId}
            milestones={sortedMilestones}
            onDelete={confirmDeleteTask}
          />
        );
      });
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <section className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <h2 className="flex-1 text-base font-semibold text-ink">Activity</h2>
        {isLocked && (
          <Badge tone="warning" className="gap-1">
            Timeline locked
          </Badge>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            modal.open(
              <TaskForm projectId={projectId} milestones={sortedMilestones} />,
              { title: "New Task", size: "lg" }
            )
          }
        >
          <Plus size={14} className="mr-1" />
          Task
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() =>
            modal.open(<MilestoneForm projectId={projectId} />, {
              title: "New Milestone",
            })
          }
        >
          <Plus size={14} className="mr-1" />
          Milestone
        </Button>
      </div>

      {/* Empty state */}
      {isEmpty ? (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-border-subtle bg-surface py-16 text-center">
          <Diamond size={32} className="text-ink-muted opacity-40" />
          <p className="text-sm text-ink-secondary">
            No milestones yet — add one to start tracking.
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              modal.open(<MilestoneForm projectId={projectId} />, {
                title: "New Milestone",
              })
            }
          >
            <Plus size={14} className="mr-1" />
            Milestone
          </Button>
        </div>
      ) : (
        /* Table */
        <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
          <table className="w-full border-collapse text-left" role="table">
            <thead>
              <tr className="border-b border-border-subtle bg-sunken/60">
                <th className="py-2.5 pl-4 pr-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
                  #
                </th>
                <th
                  className="py-2.5 pr-3 text-xs font-medium uppercase tracking-wide text-ink-muted"
                  colSpan={2}
                >
                  Name
                </th>
                <th className="py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Date
                </th>
                <th className="py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Priority
                </th>
                <th className="py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Status
                </th>
                <th className="py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Progress
                </th>
                <th className="w-28 py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-ink-muted" />
              </tr>
            </thead>
            <tbody>{rows}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
