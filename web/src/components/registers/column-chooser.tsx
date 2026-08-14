"use client";

import { useEffect, useRef, useState } from "react";
import { Columns3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export type ColumnDef = { key: string; label: string };

/**
 * Per-register column visibility (L-11). At least one column must always
 * stay checked — the last remaining checkbox is disabled rather than
 * silently ignored, so the constraint is visible, not just enforced.
 * Persistence (saved-view config vs. localStorage when no view is active)
 * is the CALLER's responsibility — this component is pure presentation over
 * `visible`/`onChange`, the same split FilterBar uses.
 */
export function ColumnChooser({
  columns,
  visible,
  onChange,
}: {
  columns: readonly ColumnDef[];
  visible: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  function toggle(key: string) {
    if (visible.includes(key)) {
      if (visible.length <= 1) return; // cannot hide everything
      onChange(visible.filter((k) => k !== key));
    } else {
      onChange([...visible, key]);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="min-h-[44px] sm:min-h-0"
        onClick={() => setOpen((o) => !o)}
      >
        <Columns3 size={14} className="mr-1.5" />
        Columns
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-56 rounded-lg border border-border-subtle bg-surface p-2 shadow-lg">
          <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            Visible columns
          </p>
          <ul>
            {columns.map((col) => {
              const checked = visible.includes(col.key);
              const disableUncheck = checked && visible.length <= 1;
              return (
                <li key={col.key}>
                  <label
                    className={cn(
                      "flex min-h-[44px] items-center gap-2 rounded-md px-2 text-sm text-ink sm:min-h-0 sm:py-1.5",
                      disableUncheck ? "opacity-60" : "hover:bg-sunken",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disableUncheck}
                      onChange={() => toggle(col.key)}
                    />
                    {col.label}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
