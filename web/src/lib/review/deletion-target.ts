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
