"use client";

import { cn } from "@/lib/cn";

export type GroupByOption = { value: string; label: string };

/** Group-by selector (L-09). Same select styling as FilterBar's own <select> —
 * kept local rather than exported from filter-bar.tsx so this stays a
 * register-toolbar control, not a filter. */
export function GroupBySelect({
  options,
  value,
  onChange,
  className,
}: {
  options: readonly GroupByOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">Group by</label>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className={cn(
          "h-11 sm:h-9 min-w-[9rem] rounded-md border border-border-subtle bg-canvas px-2.5 text-base text-ink sm:text-sm",
          "focus:outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-accent/30",
        )}
      >
        <option value="">None</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
