"use client";

import { useState, useCallback } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Severity } from "@/components/ui/severity";
import { cn } from "@/lib/cn";
import { STALE_STATUS_AGE_DAYS } from "@/lib/insight/status-age";
import { useInspector } from "@/components/layout/app-shell";
import { TaskDetailPanel } from "@/components/tracking/detail-panel";
import type { Milestone, Task as RichTask } from "@/components/tracking/activity-table";
import { useMediaQuery, QUERY_MD_UP } from "@/lib/hooks/use-media-query";

// ── Types ──────────────────────────────────────────────────────────────────

type TaskStatusType = "backlog" | "unstarted" | "started" | "completed" | "canceled";
type PriorityLevel = "low" | "medium" | "high" | "urgent";

interface Task {
  id: string;
  name: string;
  status_type: TaskStatusType;
  priority: PriorityLevel;
  [key: string]: unknown;
}

interface KanbanBoardProps {
  projectId: string;
  isLocked: boolean;
  tasks: Task[];
  /** Optional — when supplied, a card tap opens the same TaskDetailPanel the
   *  Activity tab uses. Board tabs that don't pass these keep the card
   *  drag-only, exactly as before. */
  milestones?: Milestone[];
  members?: Record<string, string>;
}

// ── Constants ──────────────────────────────────────────────────────────────

const COLUMN_ORDER: TaskStatusType[] = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
];

const COLUMN_TITLES: Record<TaskStatusType, string> = {
  backlog: "Backlog",
  unstarted: "To do",
  started: "In progress",
  completed: "Done",
  canceled: "Canceled",
};

// ── Draggable task card ────────────────────────────────────────────────────

interface TaskCardProps {
  task: Task;
  movedNote: boolean;
  isLocked: boolean;
  /** Touch drag on a scrollable phone column is unreliable next to a tap-to-
   *  open gesture, so drag is desktop-only; phones get tap-to-open instead. */
  dragEnabled: boolean;
  onOpen?: () => void;
}

function TaskCard({ task, movedNote, isLocked, dragEnabled, onOpen }: TaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled: isLocked || !dragEnabled });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // L-23 status-aging — server-computed (see status-age.ts), merged onto the
  // task row in projects/[id]/page.tsx. NOTE: a drag move here updates
  // status_type optimistically but does not re-derive this age (that needs
  // a fresh audit_log read) — it stays showing the pre-move age until the
  // next full page load/refresh, same as the rest of this board's local state.
  const statusAgeDays = typeof task.status_age_days === "number" ? task.status_age_days : null;
  const statusAgeSince = task.status_age_since === "created" ? "created" : "status_change";
  const isStale = statusAgeDays !== null && statusAgeDays > STALE_STATUS_AGE_DAYS;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(isLocked || !dragEnabled ? {} : { ...attributes, ...listeners })}
      onClick={onOpen}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={
        onOpen
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen();
              }
            }
          : undefined
      }
      className={cn(
        // kanban-card: density-compact hook (globals.css) — not a Tailwind
        // utility, purely a CSS-selector target.
        "kanban-card rounded-md border border-border-subtle bg-surface px-3 py-2.5 text-sm",
        "transition-shadow",
        // touch-action: none on the draggable node so dnd-kit's PointerSensor
        // can claim touch gestures without the page hijacking them as a scroll
        // (same precedent as the sortable shortcut tiles in bottom-nav.tsx).
        !isLocked && dragEnabled && "touch-none",
        isDragging
          ? "opacity-50 shadow-md z-50"
          : "hover:shadow-sm",
        onOpen && "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
        !dragEnabled
          ? "cursor-pointer"
          : isLocked
            ? "cursor-default"
            : "cursor-grab active:cursor-grabbing",
      )}
    >
      <p className="font-medium text-ink leading-snug">{task.name}</p>
      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
        <Severity level={task.priority} />
        {statusAgeDays !== null && (
          <span
            className={cn(
              "text-xs font-medium tabular-nums",
              isStale ? "text-warning-ink" : "text-ink-muted",
            )}
            title={statusAgeSince === "created" ? "Never moved — age since created" : "Days in current status"}
          >
            {statusAgeDays}d{statusAgeSince === "created" ? " since created" : ""}
          </span>
        )}
        {movedNote && (
          <span className="text-xs text-success-ink font-medium">
            moved — audited ✓
          </span>
        )}
      </div>
    </div>
  );
}

// ── Column ─────────────────────────────────────────────────────────────────

interface ColumnProps {
  status: TaskStatusType;
  tasks: Task[];
  movedIds: Set<string>;
  isLocked: boolean;
  dragEnabled: boolean;
  onOpenTask?: (task: Task) => void;
}

function KanbanColumn({ status, tasks, movedIds, isLocked, dragEnabled, onOpenTask }: ColumnProps) {
  const ids = tasks.map((t) => t.id);
  const { setNodeRef } = useDroppable({ id: "col:" + status });

  return (
    // Phones (below sm): ~85vw so exactly one column-and-a-bit is visible per
    // swipe, snapping cleanly. sm-lg: fixed 16rem flex item so the board's
    // overflow-x-auto has something to scroll (1fr grid tracks never
    // overflow). lg and up: min-w reset so the parent's grid-cols-5 tracks
    // size exactly as before — pixel-identical to the pre-fix desktop layout.
    <div className="flex min-w-[85vw] shrink-0 snap-start flex-col min-h-0 sm:min-w-[16rem] lg:min-w-0">
      {/* Column header */}
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">
          {COLUMN_TITLES[status]}
        </span>
        <span className="text-xs text-ink-muted">{tasks.length}</span>
      </div>

      {/* Drop zone */}
      <div
        ref={setNodeRef}
        className={cn(
          "flex-1 rounded-lg border border-border-subtle px-2 py-2 min-h-24",
          "bg-canvas transition-colors",
          tasks.length === 0 && "border-dashed",
        )}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                movedNote={movedIds.has(task.id)}
                isLocked={isLocked}
                dragEnabled={dragEnabled}
                onOpen={onOpenTask ? () => onOpenTask(task) : undefined}
              />
            ))}
          </div>
        </SortableContext>

        {tasks.length === 0 && (
          <p className="py-4 text-center text-xs text-ink-muted">Empty</p>
        )}
      </div>
    </div>
  );
}

// ── Board ──────────────────────────────────────────────────────────────────

export function KanbanBoard({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  projectId: _projectId,
  isLocked,
  tasks: initialTasks,
  milestones,
  members,
}: KanbanBoardProps) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  // Tracks task IDs that recently moved (show inline confirmation)
  const [recentlyMoved, setRecentlyMoved] = useState<Set<string>>(new Set());

  const inspector = useInspector();
  // Touch drag on a scrollable phone column fights the snap-scroll gesture,
  // so drag is desktop-only (md+); phones get tap-to-open instead (below).
  const isDesktop = useMediaQuery(QUERY_MD_UP, true);

  const openTask = milestones
    ? (task: Task) => {
        inspector.open(
          <TaskDetailPanel
            task={task as unknown as RichTask}
            milestones={milestones}
            tasks={tasks as unknown as RichTask[]}
            members={members}
            isLocked={isLocked}
          />,
          task.name,
        );
      }
    : undefined;

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Group tasks by status_type
  const byStatus = useCallback(
    (status: TaskStatusType) => tasks.filter((t) => t.status_type === status),
    [tasks],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      // Resolve target status: over.id is either 'col:<status>' (column droppable)
      // or a task id (sortable within / across columns).
      const overId = String(over.id);
      let newStatus: TaskStatusType;
      if (overId.startsWith("col:")) {
        newStatus = overId.slice(4) as TaskStatusType;
      } else {
        const targetTask = tasks.find((t) => t.id === overId);
        if (!targetTask) return;
        newStatus = targetTask.status_type;
      }

      const draggedTask = tasks.find((t) => t.id === active.id);
      if (!draggedTask || draggedTask.status_type === newStatus) return;

      // Optimistic update
      const prevTasks = tasks;
      const updatedTasks = tasks.map((t) =>
        t.id === active.id ? { ...t, status_type: newStatus } : t,
      );
      setTasks(updatedTasks);

      // Show "moved — audited ✓" note
      const taskId = active.id as string;
      setRecentlyMoved((prev) => new Set([...prev, taskId]));
      setTimeout(() => {
        setRecentlyMoved((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }, 3500);

      // Persist via REST API
      try {
        const res = await fetch(`/api/tasks/${taskId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status_type: newStatus }),
        });
        if (!res.ok) throw new Error("patch failed");
      } catch {
        // Revert on error
        setTasks(prevTasks);
        setRecentlyMoved((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }
    },
    [tasks],
  );

  return (
    <div className="space-y-3">
      {/* Locked banner */}
      {isLocked && (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning-ink">
          Timeline locked — changes require a rebaseline.
        </div>
      )}

      {/* Board */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        {/*
          Below lg: horizontal-scroll strip (flex row, columns get a real
          min-width from KanbanColumn so overflow-x-auto has something to
          overflow). At lg and above: switch back to the original fluid
          grid-cols-5 — unchanged from before this fix.
        */}
        <div className="flex gap-4 overflow-x-auto pb-2 snap-x snap-mandatory lg:grid lg:grid-cols-5 lg:snap-none">
          {COLUMN_ORDER.map((status) => (
            <KanbanColumn
              key={status}
              status={status}
              tasks={byStatus(status)}
              movedIds={recentlyMoved}
              isLocked={isLocked}
              dragEnabled={isDesktop}
              onOpenTask={openTask}
            />
          ))}
        </div>
      </DndContext>

      {tasks.length === 0 && !isLocked && (
        <p className="py-8 text-center text-sm text-ink-muted">
          No tasks yet for this project.
        </p>
      )}
    </div>
  );
}
