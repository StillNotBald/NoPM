"use client";

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
  arrayMove,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Item } from "./bottom-nav";

/** A pinned shortcut tile that can be dragged to reorder (Edit mode only). */
function SortableShortcut({ item, onRemove }: { item: Item; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.href,
  });
  const Icon = item.icon;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      className={cn(
        "relative flex touch-none cursor-grab select-none flex-col items-center gap-1.5 rounded-xl bg-accent/10 py-3 text-[11px] text-accent",
        isDragging && "z-10 cursor-grabbing opacity-80 shadow-md",
      )}
    >
      {/* 16px glyph with a 44px hit area (pseudo-element) so the tile does not grow */}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRemove}
        className="focus-ring absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-ink/60 text-canvas before:absolute before:-inset-3.5 before:content-['']"
        aria-label={`Remove ${item.label}`}
      >
        <X size={11} strokeWidth={3} />
      </button>
      <Icon size={22} />
      <span className="max-w-full truncate px-1">{item.label}</span>
    </div>
  );
}

/**
 * Drag-to-reorder shortcut grid for the bottom-nav "Edit" sheet. Pulled out
 * of bottom-nav.tsx so @dnd-kit/{core,sortable,utilities} — mounted on every
 * page via app-shell.tsx — only loads when a viewer actually opens Edit mode
 * (bottom-nav.tsx lazy-loads this component with `next/dynamic({ ssr: false })`).
 */
export default function BottomNavSortable({
  items,
  order,
  onReorder,
  onRemove,
}: {
  /** Pinned items, in `order`. */
  items: Item[];
  /** Current shortcut hrefs, in display order — the sortable identity list. */
  order: string[];
  onReorder: (next: string[]) => void;
  onRemove: (href: string) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (over && active.id !== over.id) {
      const from = order.indexOf(String(active.id));
      const to = order.indexOf(String(over.id));
      if (from !== -1 && to !== -1) onReorder(arrayMove(order, from, to));
    }
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={order} strategy={horizontalListSortingStrategy}>
        <div className="grid grid-cols-4 gap-1 px-1 sm:grid-cols-5">
          {items.map((item) => (
            <SortableShortcut key={item.href} item={item} onRemove={() => onRemove(item.href)} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
