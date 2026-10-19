/**
 * lib/review/deletion-target.ts
 *
 * What a deletion request is ABOUT, in words. A request stores a `before`
 * snapshot of the row it would delete (decide.ts titles events from the same
 * field), so the approver can see "Task: Cutover plan, in Apollo" beside the
 * Approve button instead of a 36-character id. Pure helpers; the pages and the
 * review gatherer both use them.
 */
import { clip } from "./pending";

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

export interface DeletionTarget {
  /** "task", "project", … as the request records it. */
  type: string;
  /** The deleted row's own name/title, or null when the snapshot has none. */
  name: string | null;
  /** The project the target lives in (a project's own id when the target IS a project). */
  projectId: string | null;
}

export function describeDeletionTarget(req: {
  target_type: string;
  target_id: string;
  before?: unknown;
}): DeletionTarget {
  const before = isRow(req.before) ? req.before : {};
  const counts = isRow(before.child_counts) ? before.child_counts : {};
  // An allocation has no name of its own: the request snapshot records resource, project, task and window (0113).
  const name = clip(before.name ?? before.title ?? before.description ?? counts.display_name, 120);
  const projectId =
    req.target_type === "project"
      ? req.target_id
      : typeof before.project_id === "string"
        ? before.project_id
        : null;
  return { type: req.target_type, name, projectId };
}

/** "Task “Cutover plan”" for accessible names and one-line titles; the type alone when unnamed. */
export function targetPhrase(target: Pick<DeletionTarget, "type" | "name">): string {
  return target.name ? `${target.type} “${target.name}”` : target.type;
}

/** The heading above the counts: a milestone, program or sprint detaches what is under it, a project or resource deletes. */
export function childCountsHeading(targetType: string): string {
  return targetType === "milestone" || targetType === "program" || targetType === "sprint"
    ? "Approving also detaches:"
    : "Approving also deletes:";
}

/** The request types whose approval also touches other records, so the approver is shown the counts. */
const TYPES_WITH_CHILD_COUNTS: ReadonlySet<string> = new Set(["project", "milestone", "program", "sprint", "resource"]);
export function showsChildCounts(targetType: string): boolean {
  return TYPES_WITH_CHILD_COUNTS.has(targetType);
}

// ── What a project deletion also takes with it (D2 / Q-GOV-12) ────────────────

export interface ChildCountLine {
  key: string;
  label: string;
  count: number;
  /** Governed records (decided/auditable) rather than plain work items. */
  governed: boolean;
  /** True when approving KEEPS the record and only unlinks it (a resource's assigned tasks); shown under its own heading. */
  kept?: boolean;
}

const CHILD_LABELS: Record<string, string> = {
  tasks: "tasks",
  projects: "projects",
  assigned_tasks: "assigned tasks (no longer assigned to this person)",
  milestones: "milestones",
  risks: "risks",
  issues: "issues",
  clashes: "clashes",
  time_entries: "time entries",
  resource_allocations: "resource allocations",
  allocations: "allocations",
  budget_lines: "budget lines",
  budgets: "budgets",
  sprints: "sprints",
  change_requests: "change requests",
  decisions: "decisions",
  documents: "documents",
  rebaselines: "rebaselines",
  rebaseline_signoffs: "rebaseline sign-offs",
  deletion_requests: "deletion requests",
};

const GOVERNED = new Set(["change_requests", "decisions", "documents", "rebaselines", "rebaseline_signoffs"]);

/**
 * The non-zero child counts recorded in a project-deletion request's `before`
 * snapshot (`before.child_counts`), as friendly lines. Renders whatever keys
 * exist (generic), skips the reserved `_scope` fingerprint and nested objects,
 * and puts governed records last so the approver sees them called out.
 */
export function describeChildCounts(before: unknown, targetType?: string): ChildCountLine[] {
  const counts = isRow(before) && isRow(before.child_counts) ? before.child_counts : {};
  const lines: ChildCountLine[] = [];
  for (const [key, value] of Object.entries(counts)) {
    if (key.startsWith("_") || typeof value !== "number" || !(value > 0)) continue;
    lines.push({
      key,
      label:
        targetType === "milestone" && key === "tasks"
          ? "tasks (kept, no longer under this milestone)"
          : targetType === "program" && key === "projects"
            ? "projects (kept, no longer in this program)"
            : (CHILD_LABELS[key] ?? key.replace(/_/g, " ")),
      count: value,
      governed: GOVERNED.has(key),
      ...(targetType === "resource" && key === "assigned_tasks" ? { kept: true } : {}),
    });
  }
  return lines.sort((a, b) => Number(a.governed) - Number(b.governed) || a.label.localeCompare(b.label));
}
