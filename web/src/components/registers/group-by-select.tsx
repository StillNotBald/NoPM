"use client";

import { useId } from "react";
import { cn } from "@/lib/cn";
import { selectClass } from "@/components/registers/filter-bar";

export type GroupByOption = { value: string; label: string };

/** Group-by selector (L-09). Shares FilterBar's select styling so the toolbar row lines up. */
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
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
        Group by
      </label>
      <select
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className={selectClass}
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
