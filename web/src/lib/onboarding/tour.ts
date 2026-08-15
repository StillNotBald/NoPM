/**
 * Governance tour (L-50, R-77) — pure helpers for the dismissible 5-item
 * deep-link checklist card (components/onboarding/governance-tour.tsx).
 * Kept free of any fetch/React, same idiom as lib/onboarding/steps.ts, so the
 * visited/dismiss rules are unit-testable without mocking the network.
 *
 * Persistence shape mirrors the `tour` key added to preferencesConfigSchema
 * (web/src/app/api/me/preferences/_schema.ts):
 *   { dismissed?: boolean, visited?: string[] (max 12, item ids) }
 */

export interface TourItem {
  id: string;
  title: string;
  caption: string;
  href: string;
}

export interface TourState {
  dismissed?: boolean;
  visited?: string[];
}

/** Cap on the persisted `visited` array — matches the schema's `.max(12)`. */
export const MAX_VISITED = 12;

/**
 * The 5 governance-tour stops, in display order. `firstProjectHref` lets the
 * caller substitute a real project deep link for stop 4 when the workspace
 * has at least one project (dashboard/page.tsx only mounts this component
 * when it does — but the fallback keeps this pure function total).
 */
export function tourItems(firstProjectHref?: string): TourItem[] {
  return [
    {
      id: "trust-center",
      title: "Trust Center",
      caption: "The immutable audit stream behind every change.",
      href: "/trust",
    },
    {
      id: "review-queue",
      title: "Review Queue",
      caption: "Four-eyes decisions, including timesheet approvals.",
      href: "/review",
    },
    {
      id: "sprints",
      title: "Sprints",
      caption: "Governed transitions, burndown, and velocity.",
      href: "/sprints",
    },
    {
      id: "project-lock",
      title: "Project lock & rebaseline",
      caption: "Lock a project's plan, then rebaseline it under governance.",
      href: firstProjectHref || "/projects",
    },
    {
      id: "connect-agent",
      title: "Connect an AI agent",
      caption: "Scoped, revocable access for your own agent.",
      href: "/tokens#connect-agent",
    },
  ];
}

/** Whether the tour card should render at all, given persisted state. */
export function shouldShowTour(state: TourState | undefined): boolean {
  return !state?.dismissed;
}

/** Whether a given item id has already been visited. */
export function isVisited(state: TourState | undefined, itemId: string): boolean {
  return !!state?.visited?.includes(itemId);
}

/**
 * New state after visiting `itemId` — dedups and caps the array at
 * MAX_VISITED (oldest-first eviction if somehow exceeded; in practice there
 * are only 5 items so this never trims a real visit).
 */
export function markVisited(state: TourState | undefined, itemId: string): TourState {
  const existing = state?.visited ?? [];
  if (existing.includes(itemId)) return { ...state, visited: existing };
  const next = [...existing, itemId].slice(-MAX_VISITED);
  return { ...state, visited: next };
}

/** New state after the user dismisses the tour card (the X control). */
export function dismissTour(state: TourState | undefined): TourState {
  return { ...state, dismissed: true };
}
