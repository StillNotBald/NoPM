"use client";

import { FilterBar } from "@/components/registers/filter-bar";
import { useListControls, type FilterFieldConfig } from "@/components/registers/use-list-controls";

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
    />
  );
}
