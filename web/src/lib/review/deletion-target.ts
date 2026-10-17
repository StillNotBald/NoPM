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
  const name = clip(before.name ?? before.title, 120);
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

// ── What a project deletion also takes with it (D2 / Q-GOV-12) ────────────────

export interface ChildCountLine {
  key: string;
  label: string;
  count: number;
  /** Governed records (decided/auditable) rather than plain work items. */
  governed: boolean;
}

const CHILD_LABELS: Record<string, string> = {
  tasks: "tasks",
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
export function describeChildCounts(before: unknown): ChildCountLine[] {
  const counts = isRow(before) && isRow(before.child_counts) ? before.child_counts : {};
  const lines: ChildCountLine[] = [];
  for (const [key, value] of Object.entries(counts)) {
    if (key.startsWith("_") || typeof value !== "number" || !(value > 0)) continue;
    lines.push({
      key,
      label: CHILD_LABELS[key] ?? key.replace(/_/g, " "),
      count: value,
      governed: GOVERNED.has(key),
    });
  }
  return lines.sort((a, b) => Number(a.governed) - Number(b.governed) || a.label.localeCompare(b.label));
}
