/**
 * Getting-started checklist (R-78) — pure step-derivation for the /start
 * page (app/(console)/start/page.tsx + components/onboarding/
 * start-checklist.tsx). Kept free of any fetch/React, same idiom as
 * lib/onboarding/tour.ts and lib/onboarding/steps.ts.
 *
 * Persistence for `visited` mirrors the `start` key added to
 * preferencesConfigSchema (web/src/app/api/me/preferences/_schema.ts):
 *   { dismissed?: boolean, visited?: string[] (max 12, step ids) }
 * `done` for the other four steps is derived straight from workspace data
 * (project/task/token/member counts), not from persisted state.
 */

export type StartStepKind = "write" | "read";

export interface StartStep {
  id: string;
  title: string;
  caption: string;
  href: string;
  done: boolean;
  kind: StartStepKind;
  cta: string;
  /**
   * Whether the SIGNED-IN caller can act on this step right now. Read steps
   * are always actionable; write steps require role !== "viewer" (the same
   * canWrite rule dashboard/page.tsx uses).
   */
  canAct: boolean;
}

export interface StartChecklistInput {
  projects: number;
  tasks: number;
  auditRows: number;
  tokens: number;
  members: number;
  visited: string[];
  role: string;
  /** Deep link into an existing project's board, when one exists. */
  firstProjectHref?: string;
}

/** Cap on the persisted `visited` array — matches the schema's `.max(12)`. */
export const MAX_VISITED = 12;

export function startSteps(input: StartChecklistInput): StartStep[] {
  const canWrite = input.role !== "viewer";
  const visited = input.visited ?? [];

  return [
    {
      id: "project",
      title: "Create your first project",
      caption: "Everything hangs off a project.",
      href: "/projects",
      done: input.projects > 0,
      kind: "write",
      cta: "New project",
      canAct: canWrite,
    },
    {
      id: "task",
      title: "Add a task and move it on the board",
      caption: "A board drag is audited.",
      href: input.firstProjectHref ?? "/projects",
      done: input.tasks > 0,
      kind: "write",
      cta: "Open board",
      canAct: canWrite,
    },
    {
      id: "audit",
      title: "See the audit receipt",
      caption: "One immutable row per change.",
      href: "/trust",
      done: visited.includes("audit"),
      kind: "read",
      cta: "Open Trust Center",
      canAct: true,
    },
    {
      id: "agent",
      title: "Connect your AI agent",
      caption: "Admins create a scoped token.",
      href: "/tokens#connect-agent",
      done: input.tokens > 0,
      kind: "write",
      cta: "Mint a token",
      canAct: canWrite,
    },
    {
      id: "team",
      title: "Invite a teammate",
      caption: "Four-eyes needs a second person.",
      href: "/settings",
      done: input.members > 1,
      kind: "write",
      cta: "Invite",
      canAct: canWrite,
    },
  ];
}

export function progress(steps: StartStep[]): { done: number; total: number; pct: number } {
  const total = steps.length;
  const done = steps.filter((s) => s.done).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, pct };
}

export function allDone(steps: StartStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.done);
}

/**
 * New (partial) `start` config after visiting a read step (currently only
 * "audit" is clickable-to-mark-done) — the caller PUTs `{ start: ... }`
 * verbatim (top-level `start` is replaced whole). Dedupes and caps at
 * MAX_VISITED, evicting the oldest id first.
 */
export function markStartVisited(
  start: { dismissed?: boolean; visited?: string[] } | undefined,
  stepId: string,
): { dismissed?: boolean; visited?: string[] } {
  const existing = start?.visited ?? [];
  if (existing.includes(stepId)) return { ...start, visited: existing };
  const next = [...existing, stepId].slice(-MAX_VISITED);
  return { ...start, visited: next };
}

/** New `start` state with the checklist collapsed/expanded (the "Hide"/"Show" toggle). */
export function setStartDismissed(
  start: { dismissed?: boolean; visited?: string[] } | undefined,
  dismissed: boolean,
): { dismissed?: boolean; visited?: string[] } {
  return { ...start, dismissed };
}
