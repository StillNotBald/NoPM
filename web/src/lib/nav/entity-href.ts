// Single source of truth for "where does clicking an entity go?".
// Pure (no React) so server routes (e.g. /api/search) can import it too.

export type EntityKind =
  | "project"
  | "task"
  | "milestone"
  | "risk"
  | "issue"
  | "clash"
  | "decision"
  | "change_request"
  | "document";

/**
 * Deep-link for any entity. Register entities carry a focus query param
 * (e.g. ?risk=<id>) that the destination page reads to auto-open the
 * inspector for that record. Project-scoped entities route into the project.
 */
export function entityHref(
  kind: EntityKind,
  opts: { id: string; projectId?: string | null },
): string {
  const { id, projectId } = opts;
  switch (kind) {
    case "project":
      return `/projects/${id}`;
    case "task":
      return projectId ? `/projects/${projectId}?task=${id}` : "/my-tasks";
    case "milestone":
      return projectId ? `/projects/${projectId}?milestone=${id}` : "/projects";
    case "risk":
      return `/risks?risk=${id}`;
    case "issue":
      return `/issues?issue=${id}`;
    case "clash":
      return `/clashes?clash=${id}`;
    case "decision":
      return `/decisions?dec=${id}`;
    case "change_request":
      return `/change-control?cr=${id}`;
    case "document":
      return `/documents?doc=${id}`;
  }
}

/** The focus query-param name each register page reads to auto-open a record. */
export const FOCUS_PARAM: Record<
  Exclude<EntityKind, "project" | "task" | "milestone">,
  string
> = {
  risk: "risk",
  issue: "issue",
  clash: "clash",
  decision: "dec",
  change_request: "cr",
  document: "doc",
};
