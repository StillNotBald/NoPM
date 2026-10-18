"use client";

import { FilterBar } from "@/components/registers/filter-bar";
import { useListControls, type FilterFieldConfig } from "@/components/registers/use-list-controls";
import { cn } from "@/lib/cn";

/**
 * L-15 — dashboard-wide filter (program / project / target-date range).
 *
 * The dashboard page is a Server Component: it reads these same param keys
 * straight off `searchParams` and filters server-side (see
 * `src/app/(console)/dashboard/page.tsx`) — this bar's only job is to push
 * URL updates via `useListControls` (the same URL-encoded filter contract
 * `<FilterBar>` already uses for the registers), which triggers Next to
 * re-render the RSC with the new params. No client-side fetch involved.
 */
export function DashboardFilterBar({
  programs,
  projects,
}: {
  programs: string[];
  projects: { id: string; label: string }[];
}) {
  const fields: FilterFieldConfig[] = [
    {
      key: "program",
      label: "Program",
      type: "select",
      options: programs.map((p) => ({ value: p, label: p })),
    },
    {
      key: "project",
      label: "Project",
      type: "select",
      options: projects.map((p) => ({ value: p.id, label: p.label })),
    },
    {
      key: "date_from",
      label: "Target date",
      type: "date-range",
      fromKey: "date_from",
      toKey: "date_to",
    },
  ];

  const { filters, activeFilterCount, setFilter, clearFilters } = useListControls(fields);

  return (
    <FilterBar
      fields={fields}
      values={filters}
      onChange={setFilter}
      onClear={clearFilters}
      activeCount={activeFilterCount}
      // F3 — the Project <select> has no explicit width, so mobile Safari
      // sizes it to its longest <option> and it clips past the viewport
      // edge; the date-range pair is cramped shoulder-to-shoulder. Fixed
      // from here (not filter-bar.tsx, shared with the registers group)
      // via descendant overrides scoped to <sm only — desktop is untouched.
      className={cn(
        "max-sm:flex-col max-sm:items-stretch max-sm:gap-4",
        "max-sm:[&>div]:w-full max-sm:[&>div]:min-w-0",
        "max-sm:[&_select]:w-full max-sm:[&_select]:min-w-0",
        "max-sm:[&_input]:w-full max-sm:[&_input]:min-w-0",
        // the date-range field's own inner row (two inputs + "to") stacks
        // too — targeted structurally (its wrapper div directly holds a
        // date input) rather than by class name: an arbitrary selector on
        // a literal Tailwind class containing a "." (gap-1.5) fails to
        // parse as CSS (tried, broke the whole app's stylesheet).
        "max-sm:[&_div:has(>input[type=date])]:flex-col",
        "max-sm:[&_div:has(>input[type=date])]:items-stretch",
        "max-sm:[&_div:has(>input[type=date])]:gap-2",
      )}
    />
  );
}
