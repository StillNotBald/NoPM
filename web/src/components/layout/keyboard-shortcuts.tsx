"use client";

import { useEffect } from "react";
import { X, Command } from "lucide-react";
import { cn } from "@/lib/cn";

type ShortcutRow = {
  label: string;
  keys: string[];
};

const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform);

const MOD = isMac ? "⌘" : "Ctrl";

const SHORTCUTS: { section: string; rows: ShortcutRow[] }[] = [
  {
    section: "Navigation",
    rows: [
      { label: "Command palette", keys: [MOD, "K"] },
      { label: "Go to Dashboard", keys: [MOD, "1"] },
      { label: "Go to Projects", keys: [MOD, "2"] },
      { label: "Go to Risks", keys: [MOD, "3"] },
    ],
  },
  {
    section: "General",
    rows: [
      { label: "Close inspector / modal", keys: ["Esc"] },
      { label: "Open keyboard shortcuts", keys: [MOD, "/"] },
    ],
  },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-border-subtle bg-sunken px-1 font-mono text-[11px] text-ink-secondary">
      {children}
    </kbd>
  );
}

interface KeyboardShortcutsProps {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcuts({ open, onClose }: KeyboardShortcutsProps) {
  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    /* backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className={cn(
          "relative w-full max-w-sm rounded-xl border border-border-subtle bg-canvas shadow-xl",
          "focus:outline-none",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink">
            <Command size={15} className="text-ink-muted" />
            Keyboard shortcuts
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 place-items-center rounded-md text-ink-muted hover:bg-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X size={14} />
          </button>
        </div>

        {/* body */}
        <div className="divide-y divide-border-subtle px-5 py-3">
          {SHORTCUTS.map((group) => (
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
  );
}
