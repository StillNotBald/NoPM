import {
  Inbox,
  ListTodo,
  LayoutDashboard,
  FolderKanban,
  Map,
  Route,
  FileText,
  Layers,
  AlertTriangle,
  CircleAlert,
  Zap,
  Users,
  Wallet,
  Clock,
  ListChecks,
  GitPullRequest,
  Gavel,
  ClipboardCheck,
  Eye,
  ShieldCheck,
  KeyRound,
  Plug,
  Lock,
  Rocket,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { PendingCounts } from "@/lib/governance/pending-counts";
import type { NavMode } from "./nav-mode";

export type NavItem = { href: string; label: string; icon: LucideIcon };

export type NavSection = {
  label: string;
  items: NavItem[];
};

/**
 * THE label map — the single source of truth for what a route is called.
 * Keyed by the first path segment. Consumed by the sidebar, bottom nav,
 * command palette, breadcrumbs, and (by convention) each page's
 * `metadata.title`. Change a name here and every surface follows.
 */
export const ROUTE_LABELS: Record<string, string> = {
  "my-work": "My Work",
  "my-tasks": "My Tasks",
  dashboard: "Dashboard",
  projects: "Projects",
  portfolio: "Portfolio",
  mainline: "Mainline",
  tasks: "Tasks",
  sprints: "Sprints",
  documents: "Documents",
  risks: "Risks",
  issues: "Issues",
  clashes: "Clashes",
  resources: "Resources",
  budget: "Budget",
  timesheets: "Timesheets",
  review: "Review",
  "change-control": "Change Control",
  baselines: "Baselines",
  decisions: "Decisions",
  approvals: "Approvals",
  trust: "Trust Center",
  tokens: "Tokens",
  integrations: "Integrations",
  // Routes that are reachable but not sidebar items.
  start: "Getting started",
  settings: "Settings",
  "email-previews": "Email Previews",
};

/** Label for a route segment (no leading slash), or null when unknown. */
export function labelForSegment(segment: string): string | null {
  return ROUTE_LABELS[segment] ?? null;
}

/** Label for a nav href such as "/change-control". */
export function labelForHref(href: string): string {
  const seg = href.replace(/^\//, "").split("/")[0] ?? "";
  return ROUTE_LABELS[seg] ?? seg;
}

function item(href: string, icon: LucideIcon): NavItem {
  return { href, label: labelForHref(href), icon };
}

/**
 * The full console sidebar — 23 items across 6 sections, one unique icon
 * each (the bottom nav and command palette derive from this list too).
 * Regrouped for the UI/UX overhaul (Wave 6): Personal / Portfolio / Work /
 * Registers / Capacity / Governance. No route added or removed.
 * 2026-10-16: "Integrations" (Lark connector, account link, calendar feed)
 * joins Governance after Tokens — both are how outside tools reach NoPM.
 *
 * Sprint 1 (2026-09-06): "Baselines" lives in Governance (nav home for the
 * lock → rebaseline → sign-off → apply flow); "Email previews" is a header
 * link on /my-work (demo artefact, still routable, not nav real-estate).
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Personal",
    items: [item("/my-work", Inbox), item("/my-tasks", ListTodo)],
  },
  {
    label: "Portfolio",
    items: [
      item("/dashboard", LayoutDashboard),
      item("/portfolio", Map),
      item("/mainline", Route),
      item("/projects", FolderKanban),
    ],
  },
  {
    label: "Work",
    items: [item("/tasks", ListChecks), item("/sprints", Layers), item("/documents", FileText)],
  },
  {
    label: "Registers",
    items: [item("/risks", AlertTriangle), item("/issues", CircleAlert), item("/clashes", Zap)],
  },
  {
    label: "Capacity",
    items: [item("/resources", Users), item("/budget", Wallet), item("/timesheets", Clock)],
  },
  {
    label: "Governance",
    items: [
      item("/review", Eye),
      item("/change-control", GitPullRequest),
      item("/baselines", Lock),
      item("/decisions", Gavel),
      item("/approvals", ClipboardCheck),
      item("/trust", ShieldCheck),
      item("/tokens", KeyRound),
      item("/integrations", Plug),
    ],
  },
];

/** Every nav item, flattened (bottom-nav "Apps" sheet, command palette). */
export const ALL_NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

/** Non-sidebar destinations the command palette also offers. */
export const EXTRA_NAV_ITEMS: NavItem[] = [
  item("/start", Rocket),
  item("/settings", Settings),
];

/** The section whose pending badge is the sum of its queues. */
export const GOVERNANCE_SECTION_LABEL = "Governance";

/** Pending-decision count per governance href (zero entries omitted). */
export function pendingByHref(counts: PendingCounts | null | undefined): Record<string, number> {
  if (!counts) return {};
  const raw: Record<string, number> = {
    "/review": counts.review,
    "/approvals": counts.approvals,
    "/change-control": counts.changeControl,
    "/decisions": counts.decisions,
  };
  return Object.fromEntries(Object.entries(raw).filter(([, n]) => n > 0));
}

/** Screen-reader text for a pending count. */
export function pendingSrText(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"} awaiting your decision`;
}

/**
 * The Essentials core loop (R-78, progressive disclosure): inbox → tasks →
 * projects → rollup → the two registers everyone needs → the governance
 * showcase. 7 items, deliberately not configurable (that's the "lite"
 * posture — one curated default, not a builder).
 */
export const ESSENTIAL_HREFS: string[] = [
  "/my-work",
  "/tasks",
  "/projects",
  "/dashboard",
  "/risks",
  "/issues",
  "/trust",
];

function isActiveHref(href: string, pathname: string | null): boolean {
  if (!pathname) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Filters NAV_SECTIONS for display given the current mode and route.
 *
 * - "all": returns sections unchanged (identity).
 * - "essentials": keeps only ESSENTIAL_HREFS items, PLUS the currently
 *   active item even if it's non-essential — a deep link, command-palette
 *   jump, or search result must never land on a page invisible in the
 *   sidebar. Sections left empty after filtering are dropped entirely.
 */
export function visibleSections(
  sections: NavSection[],
  mode: NavMode,
  pathname: string | null,
): NavSection[] {
  if (mode === "all") return sections;

  const essential = new Set(ESSENTIAL_HREFS);
  const result: NavSection[] = [];
  for (const section of sections) {
    const items = section.items.filter(
      (item) => essential.has(item.href) || isActiveHref(item.href, pathname),
    );
    if (items.length > 0) result.push({ ...section, items });
  }
  return result;
}

/** How many items are hidden right now — drives the toggle's "· N more" label. */
export function hiddenCount(sections: NavSection[], mode: NavMode, pathname: string | null): number {
  const total = sections.reduce((n, s) => n + s.items.length, 0);
  const visible = visibleSections(sections, mode, pathname).reduce((n, s) => n + s.items.length, 0);
  return total - visible;
}
