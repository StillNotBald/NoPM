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
import { isStaleAge } from "@/lib/insight/status-age";
import { useStaleDays } from "@/lib/nudges/use-stale-days";
import { useInspector } from "@/components/layout/app-shell";
import { TaskDetailPanel } from "@/components/tracking/detail-panel";
import type { Milestone, Task as RichTask } from "@/components/tracking/activity-table";
import { useMediaQuery, QUERY_MD_UP } from "@/lib/hooks/use-media-query";
import { useToast } from "@/components/ui/toast";
import {
  expireSaved,
  failureMessage,
  persistMove,
  withMove,
  type MoveState,
  type MoveStates,
} from "./move-state";

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
  moveState: MoveState | null;
  isLocked: boolean;
  /** Touch drag on a scrollable phone column is unreliable next to a tap-to-
   *  open gesture, so drag is desktop-only; phones get tap-to-open instead. */
  dragEnabled: boolean;
  onOpen?: () => void;
}

function TaskCard({ task, moveState, dragEnabled, onOpen }: TaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    // a card whose move is still being saved can't be moved again: a second
    // optimistic move would race the first and could not be reverted cleanly
  } = useSortable({ id: task.id, disabled: !dragEnabled || moveState === "saving" });

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
  // R-141: the threshold is the workspace's "stale after N days" setting.
  const staleDays = useStaleDays();
  const isStale = isStaleAge(statusAgeDays, staleDays);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(!dragEnabled ? {} : { ...attributes, ...listeners })}
      onClick={onOpen}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-busy={moveState === "saving" || undefined}
      onKeyDown={
        onOpen
          ? (e) => {
              // Enter opens the task. Space is left to dnd-kit's keyboard sensor
              // (when dragging is on) so a keyboard user can still pick a card
              // up: the explicit handler used to replace dnd-kit's, which made
              // keyboard dragging impossible on every board that opens tasks.
              if (e.key === "Enter") {
                e.preventDefault();
                onOpen();
              } else if (e.key === " ") {
                if (!dragEnabled) {
                  e.preventDefault();
                  onOpen();
                } else {
                  (listeners as { onKeyDown?: (ev: React.KeyboardEvent) => void } | undefined)?.onKeyDown?.(e);
                }
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
        dragEnabled && "touch-none",
        isDragging
          ? "opacity-50 shadow-md z-50"
          : "hover:shadow-sm",
        onOpen && "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
        !dragEnabled
          ? "cursor-pointer"
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
        {moveState === "saving" && (
          <span className="text-xs text-ink-muted font-medium">saving…</span>
        )}
        {moveState === "saved" && (
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
  moveStates: MoveStates;
  isLocked: boolean;
  dragEnabled: boolean;
  onOpenTask?: (task: Task) => void;
}

function KanbanColumn({ status, tasks, moveStates, isLocked, dragEnabled, onOpenTask }: ColumnProps) {
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
                moveState={moveStates.get(task.id) ?? null}
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
  // Per-card move state. "saving" while the PATCH is in flight; "saved" (the
  // "moved — audited" note) ONLY after the API answered 2xx; removed on
  // failure, when the card is also put back.
  const [moveStates, setMoveStates] = useState<MoveStates>(new Map());
  // Polite live-region text so screen-reader users hear the outcome of a move.
  const [announcement, setAnnouncement] = useState("");
  const toast = useToast();

  const setMove = useCallback((id: string, state: MoveState | null) => {
    setMoveStates((prev) => withMove(prev, id, state));
  }, []);

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

      // Optimistic move: the card jumps to the new column right away, marked
      // "saving…". It is only called audited once the server says so.
      const taskId = active.id as string;
      const fromStatus = draggedTask.status_type;
      const updatedTasks = tasks.map((t) =>
        t.id === taskId ? { ...t, status_type: newStatus } : t,
      );
      setTasks(updatedTasks);
      setMove(taskId, "saving");
      setAnnouncement(`Moving ${draggedTask.name} to ${COLUMN_TITLES[newStatus]}…`);

      // Persist via REST API. persistMove never throws: a refusal (lock, scope,
      // rule) and a dead network both come back as { ok: false, reason }.
      const result = await persistMove(taskId, newStatus);
      if (result.ok) {
        setMove(taskId, "saved");
        setAnnouncement(`Moved ${draggedTask.name} to ${COLUMN_TITLES[newStatus]}. Change recorded in the audit log.`);
        setTimeout(() => setMoveStates((prev) => expireSaved(prev, taskId)), 3500);
        return;
      }

      // Put THIS card back (not a snapshot of the whole board, which would also
      // undo any other card moved while this save was in flight) and say why,
      // instead of silently snapping it home.
      setTasks((cur) => cur.map((t) => (t.id === taskId ? { ...t, status_type: fromStatus } : t)));
      setMove(taskId, null);
      const message = failureMessage({
        name: draggedTask.name,
        toTitle: COLUMN_TITLES[newStatus],
        fromTitle: COLUMN_TITLES[fromStatus],
        reason: result.reason,
      });
      setAnnouncement(message);
      toast.error(message, { duration: 8000 });
    },
    [tasks, setMove, toast],
  );

  return (
    <div className="space-y-3">
      {/* Outcome of the last move, for screen readers (the toast covers failures visually) */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {/* Locked banner */}
      {isLocked && (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning-ink">
          Timeline locked — dates and estimates are frozen (changes need a rebaseline). Status moves still work.
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
              moveStates={moveStates}
              isLocked={isLocked}
              dragEnabled={isDesktop}
              onOpenTask={openTask}
            />
          ))}
        </div>
      </DndContext>

      {tasks.length === 0 && !isLocked && (
        <p className="py-8 text-center text-sm text-ink-muted">
          No tasks yet for this project. Add one on the Activity tab and it will appear in its column here.
        </p>
      )}
    </div>
  );
}
