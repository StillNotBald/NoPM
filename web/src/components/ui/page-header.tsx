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
 */
export function PageHeader({
  title,
  action,
  secondaryActions,
  className,
}: {
  title: string;
  action?: ReactNode;
  secondaryActions?: ReactNode[];
  className?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hasSecondary = Boolean(secondaryActions && secondaryActions.length > 0);

  useEffect(() => {
    if (!menuOpen) return;
    function onDocMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  return (
    <div className={cn("mb-5 flex items-center justify-between gap-3", className)}>
      <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight text-ink sm:text-xl">
        {title}
      </h1>
      {(action || hasSecondary) && (
        <div className="flex shrink-0 items-center gap-2">
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
                  type="button"
                  onClick={() => setMenuOpen((v) => !v)}
                  aria-label="More actions"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  className="grid h-11 w-11 place-items-center rounded-md text-ink-secondary hover:bg-sunken"
                >
                  <MoreHorizontal size={18} />
                </button>
                {menuOpen && (
                  <>
                    <div className="fixed inset-0 z-20" onClick={() => setMenuOpen(false)} aria-hidden="true" />
                    <div
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
