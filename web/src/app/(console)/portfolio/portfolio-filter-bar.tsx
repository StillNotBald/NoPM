"use client";

import { FilterBar } from "@/components/registers/filter-bar";
import { useListControls, type FilterFieldConfig } from "@/components/registers/use-list-controls";

/**
 * Portfolio filter: program + project health (RAG). URL-encoded via
 * useListControls, so the server page reads the same keys off searchParams.
 */
export function PortfolioFilterBar({
  programs,
}: {
  programs: { value: string; label: string }[];
}) {
  const fields: FilterFieldConfig[] = [
    { key: "program", label: "Program", type: "select", options: programs },
    {
      key: "rag",
      label: "Health",
      type: "select",
      options: [
        { value: "green", label: "On track" },
        { value: "amber", label: "At risk" },
        { value: "red", label: "Delayed" },
        { value: "not_started", label: "In progress" },
        { value: "complete", label: "Complete" },
      ],
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
