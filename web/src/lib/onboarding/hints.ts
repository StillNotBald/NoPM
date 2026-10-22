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
    text: "Your open tasks, risks, issues and approvals, across all projects.",
  },
  {
    id: "my-tasks",
    match: "/my-tasks",
    text: "Every task assigned to you, by due date.",
  },
  {
    id: "tasks",
    match: "/tasks",
    text: "Every task in every project. Filter, sort, open.",
  },
  {
    id: "sprints",
    match: "/sprints",
    text: "Sprint status, burndown and velocity.",
  },
  {
    id: "projects",
    match: "/projects",
    text: "Create projects. Open one for its board, Gantt, risks and budget.",
    docHref: "/user-manual/operator/02-projects-and-tasks.md",
  },
  {
    id: "project-detail",
    match: "/projects",
    nested: true,
    text: "One project: board, Gantt, risks, budget. Board drags are audited.",
    docHref: "/user-manual/operator/02-projects-and-tasks.md",
  },
  {
    id: "portfolio",
    match: "/portfolio",
    text: "Projects grouped by program, rolled up for management.",
  },
  {
    id: "mainline",
    match: "/mainline",
    text: "Cross-project timeline of real task dependencies.",
  },
  {
    id: "documents",
    match: "/documents",
    text: "Project charters and governed files, versioned.",
  },
  {
    id: "risks",
    match: "/risks",
    text: "Every risk: exposure, mitigation, status.",
  },
  {
    id: "issues",
    match: "/issues",
    text: "Problems already happening. Risks are the ones that have not.",
  },
  {
    id: "clashes",
    match: "/clashes",
    text: "Schedule, resource and dependency conflicts across projects.",
  },
  {
    id: "resources",
    match: "/resources",
    text: "People, cost rates, capacity and allocation.",
  },
  {
    id: "budget",
    match: "/budget",
    text: "Planned, committed, actual and variance, per project.",
  },
  {
    id: "review",
    match: "/review",
    text: "Four-eyes decisions waiting for you, including deletions and changes.",
    docHref: "/user-manual/operator/04-approvals-and-trust.md",
  },
  {
    id: "change-control",
    match: "/change-control",
    text: "Change requests against a locked baseline.",
  },
  {
    id: "baselines",
    match: "/baselines",
    text: "Locked projects and the rebaselines that reopen them.",
    docHref: "/user-manual/operator/03-schedule-and-lock.md",
  },
  {
    id: "decisions",
    match: "/decisions",
    text: "A log of decisions and the reasons behind them.",
  },
  {
    id: "approvals",
    match: "/approvals",
    text: "Deletion requests waiting for a second, different approver.",
    docHref: "/user-manual/operator/04-approvals-and-trust.md",
  },
  {
    id: "trust",
    match: "/trust",
    text: "The immutable audit log: every change, who, and when.",
    docHref: "/user-manual/operator/04-approvals-and-trust.md",
  },
  {
    id: "tokens",
    match: "/tokens",
    text: "Create and revoke scoped API tokens for your AI agent.",
    docHref: "/user-manual/admin/01-workspace-admin.md",
  },
  {
    id: "email-previews",
    match: "/email-previews",
    text: "Notification emails as they would look. Nothing is sent.",
  },
  {
    id: "settings",
    match: "/settings",
    text: "Your profile, appearance and two-factor sign-in.",
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
