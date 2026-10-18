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
import { useInspector } from "@/components/layout/app-shell";
import { useModal } from "@/components/ui/modal";
import { apiDelete, apiPost } from "@/lib/api-client";
import {
  DeletionRequestedBadge,
  usePendingDeletionIds,
  useRequestDeletion,
} from "@/components/governance/request-deletion";
import { MilestoneForm } from "@/components/forms/milestone-form";
import { TaskForm } from "@/components/forms/task-form";
import {
  TaskDetailPanel,
  MilestoneDetailPanel,
} from "@/components/tracking/detail-panel";
import { formatByPref, type DateDisplayPref } from "@/lib/format/dates";
import { useDateDisplayPref } from "@/lib/theme/use-appearance";

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

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
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
  // ── content-enrichment (0008) — additive, all optional/nullable ──────────────
  acceptance_criteria?: string | null;
  estimate_hours?: number | null;
  story_points?: number | null;
  labels?: string[] | null;
  blocked_by?: string | null;
  // ── R-166 (0111) — optional, null when unset ─────────────────────────────────
  blocker_reason?: string | null;
  eta?: string | null;
  checklist?: ChecklistItem[] | null;
  // ── complement seam (0041, R-81) — additive, all optional/nullable ──────────
  source?: string | null;
  external_ref?: string | null;
  external_url?: string | null;
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface ActivityTableProps {
  projectId: string;
  milestones: Milestone[];
  tasks: Task[];
  isLocked: boolean;
  /** Optional id→display-name map (resource members / profiles) for resolving owner/assignee UUIDs. */
  members?: Record<string, string>;
  /** False until the members lookup answers; keeps raw ids off screen meanwhile. */
  membersReady?: boolean;
}

// ─── Member name resolution ────────────────────────────────────────────────────

/**
 * Resolve a person UUID (assignee_id / owner_id) to a display name using the
 * optional members map; null when no name is known (callers say "Unknown
 * member" once the lookup has finished, and print nothing before that — an
 * eight-character id fragment is not a person).
 */
function resolveMemberName(
  id: string | null,
  members?: Record<string, string>,
): string | null {
  if (!id) return null;
  return members?.[id] ?? null;
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
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-well">
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

function fmtDate(d: string | null, pref: DateDisplayPref): string {
  return d ? formatByPref(d, pref).absolute : "—";
}

function fmtDateRange(start: string | null, end: string | null, pref: DateDisplayPref): string {
  if (!start && !end) return "—";
  if (!start) return `Until ${fmtDate(end, pref)}`;
  if (!end) return `From ${fmtDate(start, pref)}`;
  return `${fmtDate(start, pref)} – ${fmtDate(end, pref)}`;
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
              "focus-ring flex w-full items-center gap-1.5 px-4 text-xs text-ink-muted",
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
    <tr className="border-t border-border-subtle bg-well/30">
      <td colSpan={colSpan} className={cn("px-4", rowPy)}>
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={label}
          aria-label={label.replace(/^\+\s*/, "")}
          disabled={saving}
          className="h-11 border-border-subtle bg-canvas text-sm focus-visible:ring-1 sm:h-7"
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

// ─── Shared row controls ───────────────────────────────────────────────────────

/** The row title is a real button (keyboard / screen-reader way into the inspector). */
const NAME_BTN =
  "focus-ring min-w-0 truncate rounded-sm text-left text-sm font-medium text-ink hover:underline";

/** Expand / collapse chevron; a 44px hit area comes from the pseudo-element. */
const EXPAND_BTN =
  "focus-ring relative shrink-0 rounded p-0.5 text-ink-muted hover:bg-well hover:text-ink before:absolute before:left-1/2 before:top-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

/**
 * Edit / delete cluster. Quiet at rest on a pointer device, but revealed by
 * hover, by keyboard focus ANYWHERE in the row (group-focus-within, so a
 * focused button is never invisible) and permanently where there is no hover.
 */
const ROW_ACTIONS =
  "flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100";

const ICON_BTN =
  "focus-ring grid h-8 w-8 place-items-center rounded text-ink-muted hover:bg-well hover:text-ink";

// ─── Milestone row ─────────────────────────────────────────────────────────────

function MilestoneRow({
  milestone,
  wbs,
  isExpanded,
  onToggle,
  projectId,
  milestones,
  tasks,
  onDelete,
  deletionRequested = false,
  density,
  onRowClick,
}: {
  milestone: Milestone;
  wbs: string;
  isExpanded: boolean;
  onToggle: () => void;
  projectId: string;
  milestones: Milestone[];
  /** Full project tasks list — forwarded to TaskForm for the Blocked-by picker. */
  tasks: Task[];
  onDelete: (id: string, name: string) => void;
  /** A deletion request for this milestone is waiting for a second person (G8). */
  deletionRequested?: boolean;
  density: Density;
  onRowClick: (milestone: Milestone) => void;
}) {
  const inspector = useInspector();
  const pref = useDateDisplayPref();
  const statusInfo = milestoneStatusBadge(milestone.status);
  const rowPy = density === "compact" ? "py-1.5" : "py-2.5";

  return (
    <tr
      className="group border-t border-border-subtle hover:bg-well/50 transition-colors duration-[200ms] cursor-pointer"
      role="row"
      onClick={() => onRowClick(milestone)}
    >
      {/* WBS */}
      <td className={cn("w-14 pl-4 pr-2", rowPy)}>
        <span className="font-mono text-xs text-ink-muted">{wbs}</span>
      </td>

      {/* Expand / name */}
      <td className={cn("pr-3 min-w-0", rowPy)} colSpan={2}>
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            className={EXPAND_BTN}
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${milestone.name}`}
            aria-expanded={isExpanded}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <Diamond size={13} className="shrink-0 text-accent" />
          {/* A real button: the row's own onClick is a mouse convenience, this is
              the way in for keyboard and screen-reader users */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRowClick(milestone); }}
            className={NAME_BTN}
          >
            {milestone.name}
          </button>
        </div>
        {/* Below @xl the status / progress / date columns are hidden: show them here */}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 @xl:hidden">
          <Badge size="sm" tone={statusInfo.tone}>{statusInfo.label}</Badge>
          <ProgressBar pct={milestone.completion_pct} />
          {milestone.target_date && (
            <span className="text-xs tabular-nums text-ink-muted @2xl:hidden">{fmtDate(milestone.target_date, pref)}</span>
          )}
        </div>
      </td>

      {/* Dates */}
      <td className={cn("hidden @2xl:table-cell pr-4 text-xs text-ink-secondary tabular-nums whitespace-nowrap", rowPy)}>
        {fmtDate(milestone.target_date, pref)}
      </td>

      {/* Priority — not applicable for milestones */}
      <td className={cn("hidden @3xl:table-cell pr-4", rowPy)} />

      {/* Status */}
      <td className={cn("hidden @xl:table-cell pr-4", rowPy)}>
        <Badge size="sm" tone={statusInfo.tone}>{statusInfo.label}</Badge>
      </td>

      {/* Progress */}
      <td className={cn("hidden @xl:table-cell pr-4 whitespace-nowrap", rowPy)}>
        <ProgressBar pct={milestone.completion_pct} />
      </td>

      {/* Row actions — shown on hover, on keyboard focus anywhere in the row,
          and always on touch (no hover there) */}
      <td className={cn("hidden @xl:table-cell w-28 pr-4", rowPy)}>
        <div
          className={ROW_ACTIONS}
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              inspector.open(
                <TaskForm
                  projectId={projectId}
                  milestoneId={milestone.id}
                  milestones={milestones}
                  tasks={tasks}
                />,
                "New Task",
              )
            }
            className="h-8 gap-1 px-2 text-xs"
            aria-label={`Add task to ${milestone.name}`}
          >
            <Plus size={12} />
            Task
          </Button>
          <button
            type="button"
            onClick={() =>
              inspector.open(
                <MilestoneForm projectId={projectId} milestone={milestone} />,
                "Edit Milestone",
              )
            }
            className={ICON_BTN}
            aria-label={`Edit milestone ${milestone.name}`}
          >
            <Pencil size={13} />
          </button>
          {deletionRequested ? (
            <DeletionRequestedBadge />
          ) : (
            <button
              type="button"
              onClick={() => onDelete(milestone.id, milestone.name)}
              className={cn(ICON_BTN, "hover:text-danger-ink")}
              aria-label={`Request deletion of milestone ${milestone.name}`}
              title="Request deletion (a different person approves it)"
            >
              <Trash2 size={13} />
            </button>
          )}
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
  tasks,
  onDelete,
  density,
  onRowClick,
  members,
  membersReady,
}: {
  task: Task;
  wbs: string;
  isLast: boolean;
  projectId: string;
  milestones: Milestone[];
  /** Full sibling-tasks list — forwarded to TaskForm for the Blocked-by picker. */
  tasks: Task[];
  onDelete: (id: string, name: string) => void;
  density: Density;
  onRowClick: (task: Task) => void;
  members?: Record<string, string>;
  membersReady: boolean;
}) {
  const inspector = useInspector();
  const pref = useDateDisplayPref();
  const statusInfo = taskStatusBadge(task.status_type);
  const assigneeName = resolveMemberName(task.assignee_id, members);
  const rowPy = density === "compact" ? "py-1.5" : "py-2";

  return (
    <tr
      className="group border-t border-border-subtle hover:bg-well/50 transition-colors duration-[200ms] cursor-pointer"
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
      <td className={cn("pr-3 min-w-0", rowPy)}>
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {/* A real button: the row's own onClick is a mouse convenience, this
                is the way in for keyboard and screen-reader users */}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRowClick(task); }}
              className={cn(NAME_BTN, "font-normal")}
            >
              {task.name}
            </button>
            {task.checklist && task.checklist.length > 0 && (
              <span className="shrink-0 inline-flex items-center gap-0.5 rounded-full border border-border-subtle bg-well px-1.5 py-0.5 text-2xs font-medium tabular-nums text-ink-muted">
                {task.checklist.filter((i) => i.done).length}/{task.checklist.length}
              </span>
            )}
          </div>
          {task.assignee_id && (
            // the line is always reserved so names arriving later don't shift rows
            <span className="min-h-4 text-xs text-ink-muted truncate">
              {assigneeName ?? (membersReady ? "Unknown member" : "\u00A0")}
            </span>
          )}
          {(task.blocker_reason || task.eta) && (
            // R-166: stacked under the name so it never adds a column or a horizontal scroll at 390 px
            <span className="text-xs text-warning-ink break-words">
              {task.blocker_reason ? `Blocked: ${task.blocker_reason}` : "Blocked"}
              {task.eta ? ` · ETA ${fmtDate(task.eta, pref)}` : ""}
            </span>
          )}
          {/* Below @xl the status / progress / date columns are hidden: show them here */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 @xl:hidden">
            <Badge size="sm" tone={statusInfo.tone}>{statusInfo.label}</Badge>
            <ProgressBar pct={task.completion_pct} />
            {(task.start_date || task.due_date) && (
              <span className="text-xs tabular-nums text-ink-muted @2xl:hidden">
                {fmtDateRange(task.start_date, task.due_date, pref)}
              </span>
            )}
          </div>
        </div>
      </td>

      {/* Date range */}
      <td className={cn("hidden @2xl:table-cell pr-4 text-xs text-ink-secondary whitespace-nowrap", rowPy)}>
        {fmtDateRange(task.start_date, task.due_date, pref)}
      </td>

      {/* Priority */}
      <td className={cn("hidden @3xl:table-cell pr-4", rowPy)}>
        <Severity level={task.priority} />
      </td>

      {/* Status */}
      <td className={cn("hidden @xl:table-cell pr-4", rowPy)}>
        <Badge size="sm" tone={statusInfo.tone}>{statusInfo.label}</Badge>
      </td>

      {/* Progress */}
      <td className={cn("hidden @xl:table-cell pr-4 whitespace-nowrap", rowPy)}>
        <ProgressBar pct={task.completion_pct} />
      </td>

      {/* Row actions — shown on hover, on keyboard focus anywhere in the row,
          and always on touch (no hover there) */}
      <td className={cn("hidden @xl:table-cell w-28 pr-4", rowPy)}>
        <div
          className={ROW_ACTIONS}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() =>
              inspector.open(
                <TaskForm
                  projectId={projectId}
                  task={task}
                  milestones={milestones}
                  tasks={tasks}
                />,
                "Edit Task",
              )
            }
            className={ICON_BTN}
            aria-label={`Edit task ${task.name}`}
          >
            <Pencil size={13} />
          </button>
          <button
            type="button"
            onClick={() => onDelete(task.id, task.name)}
            className={cn(ICON_BTN, "hover:text-danger-ink")}
            aria-label={`Delete task ${task.name}`}
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
  membersReady = true,
}: ActivityTableProps) {
  const inspector = useInspector();
  const modal = useModal();
  const router = useRouter();

  // Inline delete-error banner (shown when a delete API call fails)
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  // Inspector openers — pass the full tasks list so TaskForm can populate
  // the "Blocked by" dropdown with sibling tasks.
  function openTaskInspector(task: Task) {
    inspector.open(
      <TaskDetailPanel
        task={task}
        milestones={sortedMilestones}
        tasks={tasks}
        members={members}
        isLocked={isLocked}
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

  // Styled confirm-delete handlers (no window.confirm)
  // G8: deleting a milestone raises a request a different person approves; nothing is removed here.
  const { pending: pendingMilestoneDeletions, markRequested } = usePendingDeletionIds("milestone");
  const requestMilestoneDeletion = useRequestDeletion("milestone", {
    consequence: "Its tasks stay, but are unlinked from the milestone.",
    onRequested: markRequested,
    onError: setDeleteError,
  });
  const confirmDeleteMilestone = (id: string, name: string) => {
    setDeleteError(null);
    requestMilestoneDeletion(id, name);
  };

  const confirmDeleteTask = (id: string, name: string) => {
    setDeleteError(null);
    modal.open(
      <div className="flex flex-col gap-5">
        <p className="text-sm text-ink leading-relaxed">
          Delete task <span className="font-semibold">&ldquo;{name}&rdquo;</span>?
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
                await apiDelete(`/api/tasks/${id}`);
                router.refresh();
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
        tasks={tasks}
        onDelete={confirmDeleteMilestone}
        deletionRequested={pendingMilestoneDeletions.has(milestone.id)}
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
            tasks={tasks}
            onDelete={confirmDeleteTask}
            density={density}
            onRowClick={openTaskInspector}
            members={members}
            membersReady={membersReady}
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
        className="group border-t border-border-subtle hover:bg-well/50 transition-colors"
      >
        <td className={cn("w-14 pl-4 pr-2", rowPy)}>
          <span className="font-mono text-xs text-ink-muted">{standaloneWbs}</span>
        </td>
        <td className={cn("pr-3", rowPy)} colSpan={2}>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => toggleExpand("__standalone__")}
              className={EXPAND_BTN}
              aria-label={`${isExpanded ? "Collapse" : "Expand"} standalone tasks`}
              aria-expanded={isExpanded}
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
            <Badge size="sm" tone="neutral">{standaloneTasks.length}</Badge>
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
            tasks={tasks}
            onDelete={confirmDeleteTask}
            density={density}
            onRowClick={openTaskInspector}
            members={members}
            membersReady={membersReady}
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
    <section className="@container space-y-4">
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
            type="button"
            aria-label="Comfortable density"
            aria-pressed={density === "comfortable"}
            title="Comfortable"
            className={cn(
              "focus-ring grid h-9 w-9 place-items-center rounded text-xs transition-colors duration-[200ms]",
              density === "comfortable"
                ? "bg-accent/10 text-accent"
                : "text-ink-muted hover:text-ink hover:bg-well"
            )}
            onClick={() => setDensity("comfortable")}
          >
            <AlignJustify size={13} />
          </button>
          <button
            type="button"
            aria-label="Compact density"
            aria-pressed={density === "compact"}
            title="Compact"
            className={cn(
              "focus-ring grid h-9 w-9 place-items-center rounded text-xs transition-colors duration-[200ms]",
              density === "compact"
                ? "bg-accent/10 text-accent"
                : "text-ink-muted hover:text-ink hover:bg-well"
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
            inspector.open(
              <TaskForm
                projectId={projectId}
                milestones={sortedMilestones}
                tasks={tasks}
              />,
              "New Task",
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
            inspector.open(<MilestoneForm projectId={projectId} />, "New Milestone")
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
              inspector.open(<MilestoneForm projectId={projectId} />, "New Milestone")
            }
          >
            <Plus size={14} className="mr-1" />
            Milestone
          </Button>
        </div>
      ) : (
        /* Table */
        <div className="overflow-x-auto rounded-lg border border-border-subtle bg-surface">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-border-subtle bg-well/60">
                <th className="py-2.5 pl-4 pr-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
                  #
                </th>
                <th
                  className="py-2.5 pr-3 text-xs font-medium uppercase tracking-wide text-ink-muted"
                  colSpan={2}
                >
                  Name
                </th>
                <th className="hidden @2xl:table-cell py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Date
                </th>
                <th className="hidden @3xl:table-cell py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Priority
                </th>
                <th className="hidden @xl:table-cell py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Status
                </th>
                <th className="hidden @xl:table-cell py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-ink-muted">
                  Progress
                </th>
                <th className="hidden @xl:table-cell w-28 py-2.5 pr-4 text-xs font-medium uppercase tracking-wide text-ink-muted">
                  <span className="sr-only">Actions</span>
                </th>
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
