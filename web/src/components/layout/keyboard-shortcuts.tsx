"use client";

import { useId, useRef, type RefObject } from "react";
import { X, Command } from "lucide-react";
import { Portal } from "@/components/ui/portal";
import { useDialog } from "@/lib/hooks/use-sheet";
import { modKeyLabel, useIsMac } from "./use-is-mac";

type ShortcutRow = {
  label: string;
  keys: string[];
};

type ShortcutGroup = { section: string; rows: ShortcutRow[] };

/**
 * Every shortcut listed here is implemented — and this is all of them. The
 * only global key binding is Cmd/Ctrl+K (command-palette.tsx); the rest are
 * keys that work inside the palette and Escape on any overlay (use-sheet.ts).
 * Do not add a row without adding the handler.
 */
export function shortcutGroups(mod: string): ShortcutGroup[] {
  return [
    {
      section: "Navigation",
      rows: [{ label: "Open or close the command palette", keys: [mod, "K"] }],
    },
    {
      section: "In the command palette",
      rows: [
        { label: "Move through results", keys: ["↑", "↓"] },
        { label: "Run the highlighted result", keys: ["↵"] },
      ],
    },
    {
      section: "General",
      rows: [{ label: "Close dialog, sheet or panel", keys: ["Esc"] }],
    },
  ];
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-border-subtle bg-well px-1 font-mono text-[11px] text-ink-secondary">
      {children}
    </kbd>
  );
}

interface KeyboardShortcutsProps {
  open: boolean;
  onClose: () => void;
  /** Where focus goes on close. The menu item that opened this is gone by then, so pass the menu trigger. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function KeyboardShortcuts({ open, onClose, returnFocusRef }: KeyboardShortcutsProps) {
  const isMac = useIsMac();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape (top-most only), Tab trap, focus onto Close and back to the opener
  // when it shuts.
  useDialog({ open, onClose, containerRef: dialogRef, initialFocusRef: closeRef, openerRef: returnFocusRef, sheet: true });

  if (!open) return null;

  const groups = shortcutGroups(modKeyLabel(isMac));

  // Rendered through <Portal>: inside the header it was laid out against the
  // header (a 56px band) instead of the viewport and its title/close button
  // sat off-screen.
  return (
    <Portal>
      {/* backdrop */}
      <div
        data-shell-chrome
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        onClick={onClose}
      >
        <div
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="relative max-h-full w-full max-w-sm overflow-y-auto rounded-xl border border-border-subtle bg-canvas shadow-lg focus:outline-none"
          onClick={(e) => e.stopPropagation()}
        >
          {/* header */}
          <div className="flex items-center justify-between border-b border-border-subtle py-2 pl-5 pr-3">
            <h2 id={titleId} className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Command size={15} className="text-ink-muted" aria-hidden="true" />
              Keyboard shortcuts
            </h2>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="focus-ring grid h-11 w-11 place-items-center rounded-md text-ink-muted hover:bg-well sm:h-8 sm:w-8"
            >
              <X size={14} />
            </button>
          </div>

          {/* body */}
          <div className="divide-y divide-border-subtle px-5 py-3">
            {groups.map((group) => (
              <div key={group.section} className="py-3 first:pt-0 last:pb-0">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                  {group.section}
                </p>
                <ul className="space-y-1.5">
                  {group.rows.map((row) => (
                    <li key={row.label} className="flex items-center justify-between gap-4">
                      <span className="text-sm text-ink">{row.label}</span>
                      <span className="flex items-center gap-1">
                        {row.keys.map((k) => (
                          <Kbd key={k}>{k}</Kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Portal>
  );
}
