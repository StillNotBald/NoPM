"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Compact one-row page header: title on the left, action(s) on the right —
 * same row on every breakpoint. No subtitle (keep pages dense).
 *
 * `secondaryActions` (F9) is additive: at sm+ they render inline next to
 * `action`, exactly like another `action` would. Below sm they collapse
 * into a single 44px "More" overflow menu so e.g. a project header's
 * "Request deletion" button doesn't wrap onto its own line beside three
 * other actions. Omitting `secondaryActions` renders exactly as before —
 * every existing call site is unaffected.
 *
 * `exports` is an optional slot (e.g. an export/download menu) rendered at
 * all breakpoints before `action`, so report/export affordances sit in one
 * consistent place on every page.
 *
 * The mobile overflow menu is keyboard-operable: ArrowDown/ArrowUp/Home/End
 * move between its focusable items, Escape closes and returns focus to the
 * trigger.
 */
export function PageHeader({
  title,
  action,
  exports,
  secondaryActions,
  className,
}: {
  title: string;
  action?: ReactNode;
  /** Optional export/report controls, rendered with the actions. */
  exports?: ReactNode;
  secondaryActions?: ReactNode[];
  className?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hasSecondary = Boolean(secondaryActions && secondaryActions.length > 0);

  useEffect(() => {
    if (!menuOpen) return;
    function onDocMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  function menuItems(): HTMLElement[] {
    const root = listRef.current;
    if (!root) return [];
    return Array.from(
      root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    );
  }

  // Move focus into the menu when it opens.
  useEffect(() => {
    if (menuOpen) menuItems()[0]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);

  function onMenuKeyDown(e: React.KeyboardEvent) {
    const items = menuItems();
    if (items.length === 0) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (i + 1) % items.length;
    else if (e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next >= 0) {
      e.preventDefault();
      items[next].focus();
    }
  }

  return (
    <div className={cn("mb-5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2", className)}>
      <h1 className="min-w-0 max-w-full text-lg font-semibold tracking-tight text-ink sm:truncate sm:text-xl">
        {title}
      </h1>
      {(action || exports || hasSecondary) && (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
          {exports}
          {action}

          {hasSecondary && (
            <>
              {/* sm+: secondary actions render inline, same as `action` */}
              <div className="hidden items-center gap-2 sm:flex">
                {secondaryActions!.map((node, i) => (
                  <span key={i}>{node}</span>
                ))}
              </div>

              {/* below sm: collapse into one 44px overflow menu */}
              <div className="relative sm:hidden" ref={menuRef}>
                <button
                  ref={triggerRef}
                  type="button"
                  onClick={() => {
                    if (menuOpen) triggerRef.current?.focus();
                    setMenuOpen((v) => !v);
                  }}
                  aria-label="More actions"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  className="focus-ring grid h-11 w-11 place-items-center rounded-md text-ink-secondary hover:bg-sunken"
                >
                  <MoreHorizontal size={18} />
                </button>
                {menuOpen && (
                  <>
                    <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} aria-hidden="true" />
                    <div
                      ref={listRef}
                      onKeyDown={onMenuKeyDown}
                      role="menu"
                      className="absolute right-0 top-full z-30 mt-1.5 min-w-[200px] space-y-1 rounded-lg border border-border-subtle bg-surface p-1.5 shadow-md"
                    >
                      {secondaryActions!.map((node, i) => (
                        <div key={i} onClick={() => setMenuOpen(false)}>
                          {node}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
