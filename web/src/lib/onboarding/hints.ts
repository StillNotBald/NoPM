/**
 * Page hints (R-78) — a registry of one-line "what is this page for" strips,
 * rendered by components/onboarding/page-hint.tsx directly under the
 * breadcrumb bar. Kept free of any fetch/React, same idiom as
 * lib/onboarding/tour.ts and lib/onboarding/steps.ts, so matching/dismiss
 * rules are unit-testable without mocking the network.
 *
 * Hard rules (no modals, no stacking — see the onboarding research this was
 * commissioned from): every console page shows AT MOST one onboarding
 * surface. /dashboard already owns the first-run wizard + governance tour;
 * /start owns the getting-started checklist. Neither gets an entry here.
 *
 * Persistence shape mirrors the `hints` key added to preferencesConfigSchema
 * (web/src/app/api/me/preferences/_schema.ts):
 *   { dismissed?: string[] (max 40, hint ids) }
 */

import type { PreferencesConfig } from "@/app/api/me/preferences/_schema";

export interface PageHint {
  id: string;
  /** Pathname this hint applies to, without a trailing slash (e.g. "/risks"). */
  match: string;
  /** ONE sentence, plain language: what the page is for and when you'd use it. */
  text: string;
  /** Repo-relative path into user-manual/, only set when that file exists. */
  docHref?: string;
  docLabel?: string;
  /**
   * When true, this entry matches only strict sub-paths of `match`
   * (pathname starting with "`${match}/`"), never the bare page itself —
   * used for the project detail page's dynamic [id] segment, so
   * "/projects" (the index) and "/projects/abc" (one project) resolve to
   * different hints without regex.
   */
  nested?: boolean;
}

/**
 * The app does not serve user-manual/ itself; the repo is public, so a
 * hint's repo-relative `docHref` is turned into a GitHub blob URL by
 * `hintDocUrl`. Keeping `docHref` repo-relative lets the test suite assert
 * the file actually exists on disk.
 */
export const DOCS_BASE_URL = "https://github.com/StillNotBald/NoPM/blob/main";

export function docUrlFor(repoRelativePath: string): string {
  return `${DOCS_BASE_URL}${repoRelativePath.startsWith("/") ? "" : "/"}${repoRelativePath}`;
}

export function hintDocUrl(hint: PageHint): string | undefined {
  return hint.docHref ? docUrlFor(hint.docHref) : undefined;
}

/** Cap on the persisted `dismissed` array — matches the schema's `.max(40)`. */
export const MAX_DISMISSED = 40;

export const PAGE_HINTS: PageHint[] = [
  {
    id: "my-work",
    match: "/my-work",
    text: "My Work rolls up your open tasks, risks, issues, and approvals across every project you're on.",
  },
  {
    id: "my-tasks",
    match: "/my-tasks",
    text: "My Tasks is a flat list of every task assigned to you, sorted by due date — nothing else mixed in.",
  },
  {
    id: "tasks",
    match: "/tasks",
    text: "Tasks lists every task across all projects — filter, sort, and open any one from here.",
  },
  {
    id: "sprints",
    match: "/sprints",
    text: "Sprints tracks governed status transitions, burndown, and velocity for time-boxed iterations.",
  },
  {
    id: "projects",
    match: "/projects",
    text: "Projects is where you create and manage each project — open one to reach its board, Gantt, risks, and budget.",
    docHref: "/user-manual/operator/02-projects-and-tasks.md",
  },
  {
    id: "project-detail",
    match: "/projects",
    nested: true,
    text: "Board, Gantt, risks and budget for one project. Drag on the board is audited.",
    docHref: "/user-manual/operator/02-projects-and-tasks.md",
  },
  {
    id: "portfolio",
    match: "/portfolio",
    text: "Portfolio groups projects by program for a management-level rollup across the whole workspace.",
  },
  {
    id: "mainline",
    match: "/mainline",
    text: "Mainline is the cross-project timeline — the real task-dependency graph across your whole portfolio.",
  },
  {
    id: "documents",
    match: "/documents",
    text: "Documents holds project charters and other governed files, versioned and linked to their project.",
  },
  {
    id: "risks",
    match: "/risks",
    text: "The Risk Register tracks exposure, mitigation, and status for every risk across your projects.",
  },
  {
    id: "issues",
    match: "/issues",
    text: "Issues tracks problems already happening — as opposed to risks, which haven't happened yet.",
  },
  {
    id: "clashes",
    match: "/clashes",
    text: "Clashes surfaces schedule, resource, and dependency conflicts that cross project boundaries.",
  },
  {
    id: "resources",
    match: "/resources",
    text: "Resources holds people, cost rates, capacity, and allocation across every project.",
  },
  {
    id: "budget",
    match: "/budget",
    text: "Budget tracks planned, committed, and actual spend, plus variance, for each project.",
  },
  {
    id: "timesheets",
    match: "/timesheets",
    text: "Timesheets is where logged hours are submitted and approved against project allocations.",
  },
  {
    id: "review",
    match: "/review",
    text: "Review Queue is where four-eyes decisions land, including timesheet and deletion approvals.",
    docHref: "/user-manual/operator/04-approvals-and-trust.md",
  },
  {
    id: "change-control",
    match: "/change-control",
    text: "Change Control tracks formal change requests raised against a project's locked baseline.",
  },
  {
    id: "baselines",
    match: "/baselines",
    text: "Baselines lists every locked project and the rebaselines that reopen them under sign-off.",
    docHref: "/user-manual/operator/03-schedule-and-lock.md",
  },
  {
    id: "decisions",
    match: "/decisions",
    text: "Decisions is a log of project decisions, so the reasoning behind a call stays traceable later.",
  },
  {
    id: "approvals",
    match: "/approvals",
    text: "Approvals lists pending deletion requests waiting on a second, different approver (four-eyes).",
    docHref: "/user-manual/operator/04-approvals-and-trust.md",
  },
  {
    id: "trust",
    match: "/trust",
    text: "Trust Center is the immutable audit stream — every governed change, who made it, and when.",
    docHref: "/user-manual/operator/04-approvals-and-trust.md",
  },
  {
    id: "tokens",
    match: "/tokens",
    text: "Tokens mints and revokes scoped API keys — this is how you connect your own AI agent to NoPM.",
    docHref: "/user-manual/admin/01-workspace-admin.md",
  },
  {
    id: "email-previews",
    match: "/email-previews",
    text: "Email Previews renders the notification emails NoPM would send — nothing is actually sent (demo mode).",
  },
  {
    id: "settings",
    match: "/settings",
    text: "Settings covers your profile, appearance, and two-factor authentication for this account.",
    docHref: "/user-manual/admin/01-workspace-admin.md",
  },
];

function matches(pathname: string, hint: PageHint): boolean {
  return hint.nested ? pathname.startsWith(`${hint.match}/`) : pathname === hint.match;
}

/**
 * The hint for the given pathname, or null when the page has none (includes
 * /dashboard and /start, which deliberately have no entry above). When more
 * than one entry matches (not expected given the exact/nested split above),
 * the longest `match` wins.
 */
export function hintFor(pathname: string | null): PageHint | null {
  if (!pathname) return null;
  let best: PageHint | null = null;
  for (const hint of PAGE_HINTS) {
    if (!matches(pathname, hint)) continue;
    if (!best || hint.match.length > best.match.length) best = hint;
  }
  return best;
}

export function isHintDismissed(config: PreferencesConfig | undefined, id: string): boolean {
  return !!config?.hints?.dismissed?.includes(id);
}

/**
 * New (partial) config after dismissing hint `id` — the caller PUTs this
 * verbatim (top-level `hints` is replaced whole, per the merge-upsert
 * contract in _schema.ts's mergePreferencesConfig). Dedupes and caps at
 * MAX_DISMISSED, evicting the oldest id first.
 */
export function dismissHint(config: PreferencesConfig | undefined, id: string): PreferencesConfig {
  const existing = config?.hints?.dismissed ?? [];
  if (existing.includes(id)) return { hints: { dismissed: existing } };
  const next = [...existing, id].slice(-MAX_DISMISSED);
  return { hints: { dismissed: next } };
}
