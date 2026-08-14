"use client";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { FilterFieldConfig } from "./use-list-controls";

/**
 * Declarative filter bar (L-08) — renders a text / select / date-range
 * control per field config. Pure presentation: the caller owns state via
 * useListControls (URL-encoded, server-side pagination) and passes the
 * current values + an onChange callback. Touch targets are >=44px at
 * 390px (R-63): h-11 unconditional, narrowed to h-9 only at sm+.
 */
export function FilterBar({
  fields,
  values,
  onChange,
  onClear,
  activeCount,
  className,
}: {
  fields: readonly FilterFieldConfig[];
  values: Record<string, string>;
  onChange: (key: string, value: string | null) => void;
  onClear: () => void;
  activeCount: number;
  className?: string;
}) {
  if (fields.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-end gap-3", className)}>
      {fields.map((field) => (
        <FilterField
          key={field.type === "date-range" ? `${field.fromKey}:${field.toKey}` : field.key}
          field={field}
          values={values}
          onChange={onChange}
        />
      ))}
      {activeCount > 0 && (
        <Button variant="ghost" size="sm" onClick={onClear} className="mb-0.5 min-h-[44px] sm:min-h-0">
          Clear filters
        </Button>
      )}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
      {children}
    </label>
  );
}

const selectClass = cn(
  "h-11 sm:h-9 min-w-[9rem] rounded-md border border-border-subtle bg-canvas px-2.5 text-base text-ink sm:text-sm",
  "focus:outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-accent/30",
);

function FilterField({
  field,
  values,
  onChange,
}: {
  field: FilterFieldConfig;
  values: Record<string, string>;
  onChange: (key: string, value: string | null) => void;
}) {
  if (field.type === "text") {
    return (
      <div className="flex flex-col gap-1">
        <FieldLabel>{field.label}</FieldLabel>
        <Input
          placeholder={field.placeholder}
          value={values[field.key] ?? ""}
          onChange={(e) => onChange(field.key, e.target.value || null)}
          className="h-11 w-40 sm:h-9 sm:w-44 text-sm"
        />
      </div>
    );
  }

  if (field.type === "select") {
    return (
      <div className="flex flex-col gap-1">
        <FieldLabel>{field.label}</FieldLabel>
        <select
          value={values[field.key] ?? ""}
          onChange={(e) => onChange(field.key, e.target.value || null)}
          className={selectClass}
        >
          <option value="">All</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  // date-range
  return (
    <div className="flex flex-col gap-1">
      <FieldLabel>{field.label}</FieldLabel>
      <div className="flex items-center gap-1.5">
        <Input
          type="date"
          aria-label={`${field.label} from`}
          value={values[field.fromKey] ?? ""}
          onChange={(e) => onChange(field.fromKey, e.target.value || null)}
          className="h-11 w-[8.75rem] sm:h-9 text-sm"
        />
        <span className="text-xs text-ink-muted">to</span>
        <Input
          type="date"
          aria-label={`${field.label} to`}
          value={values[field.toKey] ?? ""}
          onChange={(e) => onChange(field.toKey, e.target.value || null)}
          className="h-11 w-[8.75rem] sm:h-9 text-sm"
        />
      </div>
    </div>
  );
}
