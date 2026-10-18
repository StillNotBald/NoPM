import type { ColumnDef } from "@/components/registers/column-chooser";

/**
 * Column model for the cross-project task register. Kept out of page.tsx so the
 * defaults are unit-testable (a Next page module may not export extras).
 */

// Only these fields are in TASK_SORT_FIELDS (src/app/api/tasks/_query.ts) —
// assignee/project/estimate columns are visible but not sortable.
export const SORTABLE_FIELDS = new Set(["name", "status_type", "priority", "due_date", "completion_pct"]);

// Project sits beside the task name: this register spans every project, and
// without it identical task names ("Run stakeholder discovery workshops" x5)
// are indistinguishable rows.
export const ALL_COLUMNS: readonly ColumnDef[] = [
  { key: "name", label: "Task" },
  { key: "project_id", label: "Project" },
  { key: "status_type", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "due_date", label: "Due" },
  { key: "completion_pct", label: "Done %" },
  { key: "assignee_id", label: "Assignee" },
  { key: "estimate_hours", label: "Estimate (h)" },
];

export const DEFAULT_COLUMNS: readonly string[] = [
  "name",
  "project_id",
  "status_type",
  "priority",
  "due_date",
  "completion_pct",
];

// Number columns: right-aligned, mono, never wrapped.
export const NUMERIC_COLUMNS = new Set(["completion_pct", "estimate_hours"]);
