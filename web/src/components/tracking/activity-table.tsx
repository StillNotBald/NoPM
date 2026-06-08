"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronRight,
  ChevronDown,
  Diamond,
  Plus,
  Pencil,
  Trash2,
  AlignJustify,
  AlignCenter,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { useModal } from "@/components/ui/modal";
import { useInspector } from "@/components/layout/app-shell";
import { apiDelete, apiPost } from "@/lib/api-client";
import { MilestoneForm } from "@/components/forms/milestone-form";
import { TaskForm } from "@/components/forms/task-form";
import {
  TaskDetailPanel,
  MilestoneDetailPanel,
} from "@/components/tracking/detail-panel";

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
  /** Optional id→display-name map (resource members / profiles) for resolving owner/assignee UUIDs. */
  members?: Record<string, string>;
}

// ─── Member name resolution ────────────────────────────────────────────────────

/**
 * Resolve a person UUID (assignee_id / owner_id) to a display name using the
 * optional members map. Falls back to a short id when no name is known.
 */
function resolveMemberName(
  id: string | null,
  members?: Record<string, string>,
): string | null {
  if (!id) return null;
  const name = members?.[id];
  if (name) return name;
  return id.length > 8 ? id.slice(0, 8) : id;
}

// ─── Density ─────────────────────────────────────────────────────────────────

type Density = "comfortable" | "compact";

// ─── Badge helpers ────────────────────────────────────────────────────────────

type BadgeTone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";

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
  return new Date(d).toLocaleDateString("en-US", {
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

// ─── Inline Quick-Add input ───────────────────────────────────────────────────

/**
 * A ghost row that, on click, becomes an inline text input.
 * Submits on Enter (and re-focuses for next entry); cancels on Esc or blur-when-empty.
 */
function QuickAddRow({
  label,
  colSpan,
  onSubmit,
  density,
}: {
  label: string;
  colSpan: number;
  onSubmit: (name: string) => Promise<void>;
  density: Density;
}) {
  const [active, setActive] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus when activated
  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  async function commit() {
    const name = value.trim();
    if (!name) {
      setActive(false);
      setValue("");
      return;
    }
    setSaving(true);
    try {
      await onSubmit(name);
      setValue("");
      // keep active so user can type the next one
      inputRef.current?.focus();
    } finally {
      setSaving(false);
    }
  }

  const rowPy = density === "compact" ? "py-1" : "py-1.5";

  if (!active) {
    return (
      <tr className="group">
        <td colSpan={colSpan}>
          <button
            className={cn(
              "flex w-full items-center gap-1.5 px-4 text-xs text-ink-muted",
              "hover:text-ink-secondary transition-colors duration-150",
              rowPy,
            )}
            onClick={() => setActive(true)}
          >
            <Plus size={11} className="opacity-60" />
            {label}
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-t border-border-subtle bg-sunken/30">
      <td colSpan={colSpan} className={cn("px-4", rowPy)}>
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={label}
          disabled={saving}
          className="h-7 border-border-subtle bg-canvas text-sm focus-visible:ring-1"
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            if (e.key === "Escape") { setActive(false); setValue(""); }
          }}
          onBlur={() => {
            if (!value.trim()) { setActive(false); setValue(""); }
          }}
        />
      </td>
    </tr>
  );
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
  density,
  onRowClick,
}: {
  milestone: Milestone;
  wbs: string;
  isExpanded: boolean;
  onToggle: () => void;
  projectId: string;
  milestones: Milestone[];
  onDelete: (id: string, name: string) => void;
  density: Density;
  onRowClick: (milestone: Milestone) => void;
}) {
  const modal = useModal();
  const statusInfo = milestoneStatusBadge(milestone.status);
  const rowPy = density === "compact" ? "py-1.5" : "py-2.5";

  return (
    <tr
      className="group border-t border-border-subtle hover:bg-sunken/50 transition-colors duration-[200ms] cursor-pointer"
      role="row"
      onClick={() => onRowClick(milestone)}
    >
      {/* WBS */}
      <td className={cn("w-14 pl-4 pr-2", rowPy)}>
        <span className="font-mono text-xs text-ink-muted">{wbs}</span>
      </td>

      {/* Expand / name */}
      <td className={cn("pr-3", rowPy)} colSpan={2}>
        <div className="flex items-center gap-1.5">
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
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
      <td className={cn("hidden md:table-cell pr-4 text-xs text-ink-secondary", rowPy)}>
        {fmtDate(milestone.target_date)}
      </td>

      {/* Priority — not applicable for milestones */}
      <td className={cn("hidden md:table-cell pr-4", rowPy)} />

      {/* Status */}
      <td className={cn("pr-4", rowPy)}>
        <Badge tone={statusInfo.tone}>{statusInfo.label}</Badge>
      </td>

      {/* Progress */}
      <td className={cn("pr-4", rowPy)}>
        <ProgressBar pct={milestone.completion_pct} />
      </td>

      {/* Row actions */}
      <td className={cn("w-28 pr-4", rowPy)}>
        <div
          className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
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
  density,
  onRowClick,
  members,
}: {
  task: Task;
  wbs: string;
  isLast: boolean;
  projectId: string;
  milestones: Milestone[];
  onDelete: (id: string, name: string) => void;
  density: Density;
  onRowClick: (task: Task) => void;
  members?: Record<string, string>;
}) {
  const modal = useModal();
  const statusInfo = taskStatusBadge(task.status_type);
  const rowPy = density === "compact" ? "py-1.5" : "py-2";

  return (
    <tr
      className="group border-t border-border-subtle hover:bg-sunken/50 transition-colors duration-[200ms] cursor-pointer"
      role="row"
      onClick={() => onRowClick(task)}
    >
      {/* WBS */}
      <td className={cn("w-14 pl-4 pr-2", rowPy)}>
        <span className="font-mono text-xs text-ink-muted">{wbs}</span>
      </td>

      {/* Tree connector + name */}
      <td className={cn("pr-1 w-5", rowPy)}>
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
      <td className={cn("pr-3", rowPy)}>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-ink">{task.name}</span>
          {task.assignee_id && (
            <span className="text-xs text-ink-muted">
              Assignee: {resolveMemberName(task.assignee_id, members)}
            </span>
          )}
        </div>
      </td>

      {/* Date range */}
      <td className={cn("hidden md:table-cell pr-4 text-xs text-ink-secondary whitespace-nowrap", rowPy)}>
        {fmtDateRange(task.start_date, task.due_date)}
      </td>

      {/* Priority */}
      <td className={cn("hidden md:table-cell pr-4", rowPy)}>
        <Severity level={task.priority} />
      </td>

      {/* Status */}
      <td className={cn("pr-4", rowPy)}>
        <Badge tone={statusInfo.tone}>{statusInfo.label}</Badge>
      </td>

      {/* Progress */}
      <td className={cn("pr-4", rowPy)}>
        <ProgressBar pct={task.completion_pct} />
      </td>

      {/* Row actions */}
      <td className={cn("w-28 pr-4", rowPy)}>
        <div
          className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.stopPropagation()}
        >
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
  members,
}: ActivityTableProps) {
  const modal = useModal();
  const inspector = useInspector();
  const router = useRouter();

  // Density toggle
  const [density, setDensity] = useState<Density>("comfortable");

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

  // Inspector openers
  function openTaskInspector(task: Task) {
    inspector.open(
      <TaskDetailPanel
        task={task}
        milestones={sortedMilestones}
        members={members}
      />,
      task.name
    );
  }

  function openMilestoneInspector(milestone: Milestone) {
    inspector.open(
      <MilestoneDetailPanel milestone={milestone} members={members} />,
      milestone.name
    );
  }

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

  // Total column count (WBS + connector + name + date + priority + status + progress + actions = 8)
  const TOTAL_COLS = 8;

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
        density={density}
        onRowClick={openMilestoneInspector}
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
            density={density}
            onRowClick={openTaskInspector}
            members={members}
          />
        );
      });

      // Inline quick-add task for this milestone
      rows.push(
        <QuickAddRow
          key={`qa-task-${milestone.id}`}
          label="+ Add task"
          colSpan={TOTAL_COLS}
          density={density}
          onSubmit={async (name) => {
            await apiPost(`/api/projects/${projectId}/tasks`, {
              name,
              milestone_id: milestone.id,
            });
            router.refresh();
          }}
        />
      );
    }
  });

  // Standalone group
  if (hasStandalone) {
    const isExpanded = expandedIds.has("__standalone__");
    const standaloneWbs = String(sortedMilestones.length + 1);
    const rowPy = density === "compact" ? "py-1.5" : "py-2.5";

    rows.push(
      <tr
        key="standalone-header"
        className="group border-t border-border-subtle hover:bg-sunken/50 transition-colors"
      >
        <td className={cn("w-14 pl-4 pr-2", rowPy)}>
          <span className="font-mono text-xs text-ink-muted">{standaloneWbs}</span>
        </td>
        <td className={cn("pr-3", rowPy)} colSpan={2}>
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
            density={density}
            onRowClick={openTaskInspector}
            members={members}
          />
        );
      });

      // Inline quick-add for standalone tasks
      rows.push(
        <QuickAddRow
          key="qa-task-standalone"
          label="+ Add task"
          colSpan={TOTAL_COLS}
          density={density}
          onSubmit={async (name) => {
            await apiPost(`/api/projects/${projectId}/tasks`, { name });
            router.refresh();
          }}
        />
      );
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <section className="space-y-4">
      {/* Toolbar — wraps on mobile */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex-1 text-base font-semibold text-ink">Activity</h2>

        {isLocked && (
          <Badge tone="warning" className="gap-1">
            Timeline locked
          </Badge>
        )}

        {/* Density toggle */}
        <div className="flex items-center rounded-md border border-border-subtle bg-surface p-0.5 gap-0.5">
          <button
            aria-label="Comfortable density"
            title="Comfortable"
            className={cn(
              "grid h-9 w-9 place-items-center rounded text-xs transition-colors duration-[200ms]",
              density === "comfortable"
                ? "bg-accent/10 text-accent"
                : "text-ink-muted hover:text-ink hover:bg-sunken"
            )}
            onClick={() => setDensity("comfortable")}
          >
            <AlignJustify size={13} />
          </button>
          <button
            aria-label="Compact density"
            title="Compact"
            className={cn(
              "grid h-9 w-9 place-items-center rounded text-xs transition-colors duration-[200ms]",
              density === "compact"
                ? "bg-accent/10 text-accent"
                : "text-ink-muted hover:text-ink hover:bg-sunken"
            )}
            onClick={() => setDensity("compact")}
          >
            <AlignCenter size={13} />
          </button>
        </div>

        <Button
          variant="secondary"
          size="sm"
          className="h-11 sm:h-10"
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
          className="h-11 sm:h-10"
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
                <th className="hidden md:table-cell py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Date
                </th>
                <th className="hidden md:table-cell py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-ink-muted">
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
            <tbody>
              {rows}
              {/* Bottom-level "Add milestone" ghost row */}
              <QuickAddRow
                label="+ Add milestone"
                colSpan={TOTAL_COLS}
                density={density}
                onSubmit={async (name) => {
                  await apiPost(`/api/projects/${projectId}/milestones`, { name });
                  router.refresh();
                }}
              />
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
