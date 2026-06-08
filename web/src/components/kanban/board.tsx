"use client";

import { useState, useCallback } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Severity } from "@/components/ui/severity";
import { cn } from "@/lib/cn";

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
}

function TaskCard({ task, movedNote, isLocked }: TaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, disabled: isLocked });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(isLocked ? {} : { ...attributes, ...listeners })}
      className={cn(
        "rounded-md border border-border-subtle bg-surface px-3 py-2.5 text-sm",
        "transition-shadow",
        isDragging
          ? "opacity-50 shadow-md z-50"
          : "hover:shadow-sm",
        isLocked ? "cursor-default" : "cursor-grab active:cursor-grabbing",
      )}
    >
      <p className="font-medium text-ink leading-snug">{task.name}</p>
      <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
        <Severity level={task.priority} />
        {movedNote && (
          <span className="text-xs text-success font-medium">
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
}

function KanbanColumn({ status, tasks, movedIds, isLocked }: ColumnProps) {
  const ids = tasks.map((t) => t.id);

  return (
    <div className="flex flex-col min-h-0">
      {/* Column header */}
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">
          {COLUMN_TITLES[status]}
        </span>
        <span className="text-xs text-ink-muted">{tasks.length}</span>
      </div>

      {/* Drop zone */}
      <div
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

export function KanbanBoard({ projectId, isLocked, tasks: initialTasks }: KanbanBoardProps) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks);
  // Tracks task IDs that recently moved (show inline confirmation)
  const [recentlyMoved, setRecentlyMoved] = useState<Set<string>>(new Set());

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
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

      // Determine target column: over.id may be a task id or a column id.
      // We map the over.id back to a status by checking which column the
      // target task belongs to — or treat over.id directly as a status key.
      const targetTask = tasks.find((t) => t.id === over.id);
      if (!targetTask) return;

      const newStatus = targetTask.status_type;
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

  // All task ids for DndContext collision detection
  const allIds = tasks.map((t) => t.id);

  return (
    <div className="space-y-3">
      {/* Locked banner */}
      {isLocked && (
        <div className="rounded-md border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm text-warning">
          Timeline locked — changes require a rebaseline.
        </div>
      )}

      {/* Board */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <div className="grid grid-cols-5 gap-4 overflow-x-auto pb-2">
          {COLUMN_ORDER.map((status) => (
            <KanbanColumn
              key={status}
              status={status}
              tasks={byStatus(status)}
              movedIds={recentlyMoved}
              isLocked={isLocked}
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
