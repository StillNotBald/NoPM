"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Pencil, Trash2, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { useInspector } from "@/components/layout/app-shell";
import { useModal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { apiDelete, apiPatch, type ApiError } from "@/lib/api-client";
import { SelectInput } from "@/components/forms/project-form";
import { cn } from "@/lib/cn";
import { MilestoneForm } from "@/components/forms/milestone-form";
import { TaskForm } from "@/components/forms/task-form";
import type { Milestone, Task } from "@/components/tracking/activity-table";
import { formatByPref, type DateDisplayPref } from "@/lib/format/dates";
import { useDateDisplayPref } from "@/lib/theme/use-appearance";

// ─── Types ────────────────────────────────────────────────────────────────────

type BadgeTone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";

// Tone → text color for the status <select> (keeps the at-a-glance semantic
// color the old read-only Badge gave, on an element that stays interactive).
const statusToneText: Record<BadgeTone, string> = {
  neutral: "text-ink-secondary",
  accent: "text-accent",
  info: "text-info-ink",
  success: "text-success-ink",
  warning: "text-warning-ink",
  danger: "text-danger-ink",
};

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

function fmtDate(d: string | null, pref: DateDisplayPref): string {
  return d ? formatByPref(d, pref).absolute : "—";
}

// ─── Member name resolution ─────────────────────────────────────────────────────

/**
 * Resolve a person UUID (assignee_id / owner_id) to a display name using the
 * optional members map. An id fragment is not a person, so an unknown id reads
 * "Unknown member".
 */
function resolveMemberName(
  id: string | null,
  members?: Record<string, string>,
): string | null {
  if (!id) return null;
  return members?.[id] ?? "Unknown member";
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
  tasks = [],
  members,
  isLocked = false,
}: {
  task: Task;
  milestones: Milestone[];
  /** Sibling tasks — forwarded to TaskForm for the Blocked-by picker. */
  tasks?: Task[];
  members?: Record<string, string>;
  /** Timeline lock — must disable the status select exactly like it disables
   *  the Kanban drag (governed lock → rebaseline flow). */
  isLocked?: boolean;
}) {
  const inspector = useInspector();
  const modal = useModal();
  const router = useRouter();
  const toast = useToast();
  const pref = useDateDisplayPref();

  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Optimistic override for the status select below — lets a keyboard/screen-
  // reader user change status without dragging the Kanban card (WCAG 2.1.1
  // non-drag path). Reset whenever a different task is shown in this panel
  // (render-phase "adjusting state on prop change" — no effect needed).
  const [optimisticStatus, setOptimisticStatus] = useState<Task["status_type"] | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusResetKey, setStatusResetKey] = useState(task.id);
  if (task.id !== statusResetKey) {
    setStatusResetKey(task.id);
    setOptimisticStatus(null);
  }

  const currentStatusType = optimisticStatus ?? task.status_type;
  const statusInfo = taskStatusBadge(currentStatusType);

  const parentMilestone = milestones.find((m) => m.id === task.milestone_id);

  async function handleStatusChange(newStatus: Task["status_type"]) {
    if (newStatus === currentStatusType || statusSaving) return;
    const prevStatus = currentStatusType;
    setOptimisticStatus(newStatus);
    setStatusSaving(true);
    try {
      // Same endpoint + payload shape as KanbanBoard.handleDragEnd's status
      // mutation (PATCH /api/tasks/:id { status_type }) — routed through the
      // api-client helper; the mutation is audited server-side already.
      await apiPatch(`/api/tasks/${task.id}`, { status_type: newStatus });
      toast.success("Status updated — audited ✓");
      router.refresh();
    } catch (err) {
      setOptimisticStatus(prevStatus);
      toast.error((err as ApiError).message ?? "Failed to update status. Please try again.");
    } finally {
      setStatusSaving(false);
    }
  }

  function handleDelete() {
    setDeleteError(null);
    modal.open(
      <div className="flex flex-col gap-5">
        <p className="text-sm text-ink leading-relaxed">
          Delete task <span className="font-semibold">&ldquo;{task.name}&rdquo;</span>?
          This cannot be undone.
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" size="sm" className="h-10" onClick={modal.close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            className="h-10"
            onClick={async () => {
              modal.close();
              try {
                await apiDelete(`/api/tasks/${task.id}`);
                router.refresh();
                inspector.close();
              } catch (err) {
                setDeleteError(
                  err instanceof Error ? err.message : "Delete failed. Please try again."
                );
              }
            }}
          >
            <Trash2 size={13} className="mr-1.5" />
            Delete task
          </Button>
        </div>
      </div>,
      { title: "Delete task?" }
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Inline delete-error banner */}
      {deleteError && (
        <div className="rounded-md bg-danger/10 px-3 py-2.5 text-sm text-danger-ink flex items-center justify-between gap-2">
          <span>{deleteError}</span>
          <button
            onClick={() => setDeleteError(null)}
            className="shrink-0 text-danger-ink/70 hover:text-danger-ink text-xs"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      {/* Header name + status */}
      <div className="space-y-1.5">
        <p className="text-base font-semibold text-ink leading-snug">{task.name}</p>
        {task.description && (
          <p className="text-sm text-ink-secondary leading-relaxed">
            {task.description}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {/*
            Non-drag status path (WCAG 2.1.1) — the Kanban board's drag
            gesture has no keyboard/screen-reader equivalent for changing a
            task's status; this select gives every user the same mutation
            without needing to drag a card.
          */}
          <div className="w-40">
            <label htmlFor={`task-status-${task.id}`} className="sr-only">
              Task status
            </label>
            <SelectInput
              id={`task-status-${task.id}`}
              value={currentStatusType}
              disabled={statusSaving || isLocked}
              title={isLocked ? "Timeline locked — rebaseline to change status" : undefined}
              onChange={(e) =>
                handleStatusChange(e.target.value as Task["status_type"])
              }
              className={cn("text-xs font-mono font-medium", statusToneText[statusInfo.tone])}
            >
              <option value="backlog">Backlog</option>
              <option value="unstarted">To do</option>
              <option value="started">In progress</option>
              <option value="completed">Completed</option>
              <option value="canceled">Canceled</option>
            </SelectInput>
          </div>
          <Severity level={task.priority} />
        </div>
      </div>

      {/* Progress bar */}
      <div className="rounded-lg bg-sunken/50 px-3 py-3">
        <DetailProgress pct={task.completion_pct} />
      </div>

      {/* Checklist */}
      {task.checklist && task.checklist.length > 0 && (() => {
        const doneCount = task.checklist.filter((i) => i.done).length;
        const totalCount = task.checklist.length;
        const pct = Math.round((doneCount / totalCount) * 100);
        return (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-ink-muted uppercase tracking-wide">
                Checklist
              </span>
              <span className="text-xs tabular-nums text-ink-muted">
                {doneCount}/{totalCount} &middot; {pct}%
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken">
              <div
                className="h-full rounded-full bg-accent transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
            <ul className="space-y-1 rounded-md border border-border-subtle bg-sunken/40 px-3 py-2">
              {task.checklist.map((item) => (
                <li key={item.id} className="flex items-center gap-2 text-sm">
                  <span
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 rounded-sm border border-border-subtle flex items-center justify-center",
                      item.done ? "bg-accent border-accent" : "bg-canvas",
                    )}
                  >
                    {item.done && (
                      <svg viewBox="0 0 10 10" className="h-2.5 w-2.5 stroke-white" strokeWidth={1.8} fill="none">
                        <polyline points="1.5,5 4,7.5 8.5,2.5" />
                      </svg>
                    )}
                  </span>
                  <span className={item.done ? "line-through text-ink-muted" : "text-ink"}>
                    {item.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })()}

      {/* Grouped details */}
      <div className="rounded-lg border border-border-subtle bg-surface px-3">
        <DetailRow label="Milestone">
          {parentMilestone ? (
            <span className="text-ink">{parentMilestone.name}</span>
          ) : (
            <span className="text-ink-muted">None</span>
          )}
        </DetailRow>
        <DetailRow label="Start date">{fmtDate(task.start_date, pref)}</DetailRow>
        <DetailRow label="Due date">{fmtDate(task.due_date, pref)}</DetailRow>
        <DetailRow label="Assignee">
          {task.assignee_id ? (
            resolveMemberName(task.assignee_id, members)
          ) : (
            <span className="text-ink-muted">Unassigned</span>
          )}
        </DetailRow>
        {task.estimate_hours != null && (
          <DetailRow label="Estimate">{task.estimate_hours}h</DetailRow>
        )}
        {task.story_points != null && (
          <DetailRow label="Story points">{task.story_points}</DetailRow>
        )}
        {task.labels && task.labels.length > 0 && (
          <DetailRow label="Labels">
            <span className="flex flex-wrap justify-end gap-1">
              {task.labels.map((l) => (
                <span key={l} className="rounded-full border border-border-subtle bg-sunken px-2 py-0.5 text-xs text-ink-secondary">
                  {l}
                </span>
              ))}
            </span>
          </DetailRow>
        )}
        {task.external_ref && (
          <DetailRow label="Complement">
            {task.external_url ? (
              <a
                href={task.external_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-sunken px-2 py-0.5 text-xs text-accent hover:underline"
              >
                {task.source ? `${task.source}: ${task.external_ref}` : task.external_ref}
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-sunken px-2 py-0.5 text-xs text-ink-secondary">
                {task.source ? `${task.source}: ${task.external_ref}` : task.external_ref}
              </span>
            )}
          </DetailRow>
        )}
        <DetailRow label="Audit">
          <Link
            href={`/trust?target_type=task&target_id=${task.id}`}
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            <History size={12} />
            History
          </Link>
        </DetailRow>
      </div>

      {/* Acceptance criteria */}
      {task.acceptance_criteria && (
        <div className="rounded-lg border border-border-subtle bg-surface px-3 py-3">
          <p className="text-xs font-medium text-ink-muted uppercase tracking-wide mb-1.5">
            Acceptance criteria
          </p>
          <p className="text-sm text-ink leading-relaxed whitespace-pre-wrap">
            {task.acceptance_criteria}
          </p>
        </div>
      )}

      {/* Footer actions */}
      <div className="flex flex-col gap-2 pt-1 sm:flex-row">
        <Button
          variant="secondary"
          size="sm"
          className="flex-1 h-11 sm:h-9"
          onClick={() =>
            inspector.open(
              <TaskForm
                projectId={task.project_id}
                task={task}
                milestones={milestones}
                tasks={tasks}
              />,
              "Edit Task",
            )
          }
        >
          <Pencil size={13} className="mr-1.5" />
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-11 sm:h-9 text-danger-ink hover:bg-danger/10 sm:flex-none"
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

export function MilestoneDetailPanel({
  milestone,
  members,
}: {
  milestone: Milestone;
  members?: Record<string, string>;
}) {
  const inspector = useInspector();
  const modal = useModal();
  const router = useRouter();
  const pref = useDateDisplayPref();

  const [deleteError, setDeleteError] = useState<string | null>(null);

  const statusInfo = milestoneStatusBadge(milestone.status);

  function handleDelete() {
    setDeleteError(null);
    modal.open(
      <div className="flex flex-col gap-5">
        <p className="text-sm text-ink leading-relaxed">
          Delete milestone <span className="font-semibold">&ldquo;{milestone.name}&rdquo;</span>?
          All tasks within it will be unlinked. This cannot be undone.
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" size="sm" className="h-10" onClick={modal.close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            className="h-10"
            onClick={async () => {
              modal.close();
              try {
                await apiDelete(`/api/milestones/${milestone.id}`);
                router.refresh();
                inspector.close();
              } catch (err) {
                setDeleteError(
                  err instanceof Error ? err.message : "Delete failed. Please try again."
                );
              }
            }}
          >
            <Trash2 size={13} className="mr-1.5" />
            Delete milestone
          </Button>
        </div>
      </div>,
      { title: "Delete milestone?" }
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Inline delete-error banner */}
      {deleteError && (
        <div className="rounded-md bg-danger/10 px-3 py-2.5 text-sm text-danger-ink flex items-center justify-between gap-2">
          <span>{deleteError}</span>
          <button
            onClick={() => setDeleteError(null)}
            className="shrink-0 text-danger-ink/70 hover:text-danger-ink text-xs"
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

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
        <DetailRow label="Target date">{fmtDate(milestone.target_date, pref)}</DetailRow>
        <DetailRow label="Owner">
          {milestone.owner_id ? (
            resolveMemberName(milestone.owner_id, members)
          ) : (
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
            inspector.open(
              <MilestoneForm
                projectId={milestone.project_id}
                milestone={milestone}
              />,
              "Edit Milestone",
            )
          }
        >
          <Pencil size={13} className="mr-1.5" />
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-11 sm:h-9 text-danger-ink hover:bg-danger/10 sm:flex-none"
          onClick={handleDelete}
        >
          <Trash2 size={13} className="mr-1.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}
