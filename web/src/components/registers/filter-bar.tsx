"use client";

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { filterWritesReplaceHistory, type FilterChangeOptions, type FilterFieldConfig } from "./use-list-controls";
import { useDebouncedDraft } from "./use-debounced-draft";

/**
 * Declarative filter bar (L-08) — renders a text / select / date-range
 * control per field config. Pure presentation: the caller owns state via
 * useListControls (URL-encoded, server-side pagination) and passes the
 * current values + an onChange callback. Touch targets are >=44px at
 * 390px (R-63): h-11 unconditional, h-10 from sm up (same as the Input
 * primitive, so search and selects line up).
 *
 * Text filters are typed into a LOCAL draft and written to the URL after a
 * short pause (router.replace, not push): binding the input straight to the
 * URL dropped keystrokes and left one history entry per character. Selects
 * and dates are discrete choices and still write immediately.
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
  onChange: (key: string, value: string | null, opts?: FilterChangeOptions) => void;
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
        <Button variant="ghost" size="sm" onClick={onClear} className="min-h-[44px] sm:min-h-0 sm:h-10">
          Clear filters
        </Button>
      )}
    </div>
  );
}

function FieldLabel({
  children,
  htmlFor,
  id,
}: {
  children: React.ReactNode;
  htmlFor?: string;
  id?: string;
}) {
  return (
    <label id={id} htmlFor={htmlFor} className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
      {children}
    </label>
  );
}

export const selectClass = cn(
  "h-11 sm:h-10 min-w-[9rem] rounded-md border border-border-subtle bg-canvas px-2.5 text-base text-ink sm:text-sm",
  "focus-ring focus-visible:border-accent",
);

type FilterFieldProps = {
  field: FilterFieldConfig;
  values: Record<string, string>;
  onChange: (key: string, value: string | null, opts?: FilterChangeOptions) => void;
};

function FilterField({ field, values, onChange }: FilterFieldProps) {
  if (field.type === "text") {
    return <TextFilter field={field} value={values[field.key] ?? ""} onChange={onChange} />;
  }
  if (field.type === "select") {
    return <SelectFilter field={field} value={values[field.key] ?? ""} onChange={onChange} />;
  }
  return <DateRangeFilter field={field} values={values} onChange={onChange} />;
}

function TextFilter({
  field,
  value,
  onChange,
}: {
  field: Extract<FilterFieldConfig, { type: "text" }>;
  value: string;
  onChange: FilterFieldProps["onChange"];
}) {
  const id = useId();
  const [draft, setDraft, flush] = useDebouncedDraft(value, (next) =>
    onChange(field.key, next || null, { replace: filterWritesReplaceHistory(field) }),
  );
  return (
    <div className="flex flex-col gap-1">
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <Input
        id={id}
        placeholder={field.placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={flush}
        onKeyDown={(e) => {
          if (e.key === "Enter") flush();
        }}
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        className="w-40 text-sm sm:w-44"
      />
    </div>
  );
}

function SelectFilter({
  field,
  value,
  onChange,
}: {
  field: Extract<FilterFieldConfig, { type: "select" }>;
  value: string;
  onChange: FilterFieldProps["onChange"];
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <select
        id={id}
        value={value}
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

function DateRangeFilter({
  field,
  values,
  onChange,
}: {
  field: Extract<FilterFieldConfig, { type: "date-range" }>;
  values: Record<string, string>;
  onChange: FilterFieldProps["onChange"];
}) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-1">
      <FieldLabel id={labelId}>{field.label}</FieldLabel>
      <div className="flex items-center gap-1.5">
        <Input
          type="date"
          aria-label={`${field.label} from`}
          value={values[field.fromKey] ?? ""}
          onChange={(e) => onChange(field.fromKey, e.target.value || null)}
          className="w-[8.75rem] text-sm"
        />
        <span className="text-xs text-ink-muted" aria-hidden>
          to
        </span>
        <Input
          type="date"
          aria-label={`${field.label} to`}
          value={values[field.toKey] ?? ""}
          onChange={(e) => onChange(field.toKey, e.target.value || null)}
          className="w-[8.75rem] text-sm"
        />
      </div>
    </div>
  );
}
