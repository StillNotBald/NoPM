"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
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
import {
  LayoutDashboard,
  FolderKanban,
  AlertTriangle,
  ClipboardCheck,
  CircleAlert,
  Zap,
  Users,
  Wallet,
  ShieldCheck,
  KeyRound,
  ListTodo,
  Map,
  LayoutGrid,
  Plus,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

type Item = { href: string; label: string; icon: LucideIcon };

// Every destination available to the shortcut bar.
const ALL_ITEMS: Item[] = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard },
  { href: "/my-tasks", label: "My Tasks", icon: ListTodo },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/portfolio", label: "Portfolio", icon: Map },
  { href: "/risks", label: "Risks", icon: AlertTriangle },
  { href: "/issues", label: "Issues", icon: CircleAlert },
  { href: "/clashes", label: "Clashes", icon: Zap },
  { href: "/resources", label: "Resources", icon: Users },
  { href: "/budget", label: "Budget", icon: Wallet },
  { href: "/approvals", label: "Approvals", icon: ClipboardCheck },
  { href: "/trust", label: "Trust Center", icon: ShieldCheck },
  { href: "/tokens", label: "Tokens", icon: KeyRound },
];

const DEFAULT_SHORTCUTS = ["/dashboard", "/projects", "/risks", "/approvals"];
const MAX_SHORTCUTS = 4; // iOS tab bar: 4 shortcuts + Apps = 5 slots
const STORAGE_KEY = "nopm.bottomnav.shortcuts";

const byHref = (href: string) => ALL_ITEMS.find((i) => i.href === href);

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
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onRemove}
        className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-ink/60 text-canvas"
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
 * iOS-style bottom bar — mobile + tablet only (sidebar takes over at lg).
 * Shortcut slots are user-customizable: tap Apps → Edit to drag-reorder and
 * pin/unpin up to 4 shortcuts (persisted locally).
 */
export function BottomNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [shortcuts, setShortcuts] = useState<string[]>(DEFAULT_SHORTCUTS);

  // hydrate saved shortcuts after mount (avoids SSR mismatch)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as string[];
        const valid = parsed.filter(byHref).slice(0, MAX_SHORTCUTS);
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (valid.length) setShortcuts(valid);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const save = useCallback((next: string[]) => {
    setShortcuts(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  const pin = (href: string) => {
    if (!shortcuts.includes(href) && shortcuts.length < MAX_SHORTCUTS) save([...shortcuts, href]);
  };
  const unpin = (href: string) => save(shortcuts.filter((h) => h !== href));

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (over && active.id !== over.id) {
      const from = shortcuts.indexOf(String(active.id));
      const to = shortcuts.indexOf(String(over.id));
      if (from !== -1 && to !== -1) save(arrayMove(shortcuts, from, to));
    }
  };

  const barItems = shortcuts.map(byHref).filter(Boolean) as Item[];
  const unpinned = ALL_ITEMS.filter((i) => !shortcuts.includes(i.href));
  const atCap = shortcuts.length >= MAX_SHORTCUTS;
  const isActive = (href: string) => pathname === href || pathname?.startsWith(href + "/");

  function closeSheet() {
    setOpen(false);
    setEditing(false);
  }

  return (
    <>
      {/* expanded app sheet */}
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm lg:hidden"
          onClick={closeSheet}
        >
          <div
            className="absolute inset-x-0 bottom-0 max-h-[82vh] overflow-y-auto rounded-t-2xl bg-surface p-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-sm font-semibold text-ink">Apps</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setEditing((v) => !v)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium",
                    editing ? "bg-accent text-white" : "text-accent hover:bg-sunken",
                  )}
                >
                  {editing ? "Done" : "Edit"}
                </button>
                <button
                  onClick={closeSheet}
                  className="grid h-9 w-9 place-items-center rounded-md text-ink-secondary hover:bg-sunken"
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {editing ? (
              <>
                {/* pinned shortcuts — drag to reorder */}
                <div className="px-3 pb-1 pt-1">
                  <p className="text-xs font-medium text-ink-secondary">
                    Your shortcuts
                    <span className="ml-2 font-normal text-ink-muted">
                      drag to reorder · {shortcuts.length}/{MAX_SHORTCUTS}
                    </span>
                  </p>
                </div>
                {barItems.length > 0 ? (
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                    <SortableContext items={shortcuts} strategy={horizontalListSortingStrategy}>
                      <div className="grid grid-cols-4 gap-1 px-1 sm:grid-cols-5">
                        {barItems.map((item) => (
                          <SortableShortcut key={item.href} item={item} onRemove={() => unpin(item.href)} />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                ) : (
                  <p className="px-3 py-4 text-center text-xs text-ink-muted">
                    No shortcuts pinned — add some below.
                  </p>
                )}

                {/* add more */}
                <div className="mt-1 px-3 pb-1 pt-3">
                  <p className="text-xs font-medium text-ink-secondary">
                    Add to bar
                    {atCap && <span className="ml-2 font-normal text-ink-muted">remove one first</span>}
                  </p>
                </div>
                <div className="grid grid-cols-4 gap-1 px-1 pb-1 sm:grid-cols-5">
                  {unpinned.map(({ href, label, icon: Icon }) => (
                    <button
                      key={href}
                      onClick={() => pin(href)}
                      disabled={atCap}
                      className={cn(
                        "relative flex flex-col items-center gap-1.5 rounded-xl py-3 text-[11px] text-ink-secondary",
                        atCap ? "opacity-40" : "hover:bg-sunken",
                      )}
                    >
                      <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full border border-border-strong text-ink-muted">
                        <Plus size={11} strokeWidth={3} />
                      </span>
                      <Icon size={22} />
                      <span className="max-w-full truncate px-1 text-center leading-tight">{label}</span>
                    </button>
                  ))}
                  {unpinned.length === 0 && (
                    <p className="col-span-full px-3 py-4 text-center text-xs text-ink-muted">
                      Everything is pinned.
                    </p>
                  )}
                </div>
              </>
            ) : (
              /* browse mode — tap to navigate */
              <div className="grid grid-cols-4 gap-1 px-1 pb-1 sm:grid-cols-5">
                {ALL_ITEMS.map(({ href, label, icon: Icon }) => {
                  const active = isActive(href);
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={closeSheet}
                      className={cn(
                        "flex flex-col items-center gap-1.5 rounded-xl py-3 text-[11px]",
                        active ? "bg-sunken text-accent" : "text-ink-secondary hover:bg-sunken",
                      )}
                    >
                      <Icon size={22} />
                      <span className="max-w-full truncate px-1 text-center leading-tight">{label}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* the bar */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border-subtle bg-canvas/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
        {barItems.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px]",
                active ? "text-accent" : "text-ink-muted",
              )}
            >
              <Icon size={22} strokeWidth={active ? 2.2 : 2} />
              <span className="max-w-full truncate px-0.5">{label}</span>
            </Link>
          );
        })}
        <button
          onClick={() => setOpen(true)}
          className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] text-ink-muted"
          aria-label="All apps"
        >
          <LayoutGrid size={22} />
          <span>Apps</span>
        </button>
      </nav>
    </>
  );
}
