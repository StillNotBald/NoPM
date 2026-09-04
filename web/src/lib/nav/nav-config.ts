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
  ShieldCheck,
  KeyRound,
  Mail,
  type LucideIcon,
} from "lucide-react";
import type { NavMode } from "./nav-mode";

export type NavItem = { href: string; label: string; icon: LucideIcon };

export type NavSection = {
  label: string;
  items: NavItem[];
};

/**
 * The full console sidebar — 22 items across 5 sections. Moved out of
 * sidebar.tsx (R-78) so the pure filtering logic below can be unit-tested
 * without mounting a component. Same items, same order, same icons as
 * before this change.
 */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Overview",
    items: [
      { href: "/my-work", label: "My Work", icon: Inbox },
      { href: "/my-tasks", label: "My Tasks", icon: ListTodo },
      { href: "/tasks", label: "Tasks", icon: ListChecks },
      { href: "/sprints", label: "Sprints", icon: Layers },
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    ],
  },
  {
    label: "Delivery",
    items: [
      { href: "/projects", label: "Projects", icon: FolderKanban },
      { href: "/portfolio", label: "Portfolio", icon: Map },
      { href: "/mainline", label: "Mainline", icon: Route },
      { href: "/documents", label: "Documents", icon: FileText },
    ],
  },
  {
    label: "Registers",
    items: [
      { href: "/risks", label: "Risks", icon: AlertTriangle },
      { href: "/issues", label: "Issues", icon: CircleAlert },
      { href: "/clashes", label: "Clashes", icon: Zap },
    ],
  },
  {
    label: "Capacity",
    items: [
      { href: "/resources", label: "Resources", icon: Users },
      { href: "/budget", label: "Budget", icon: Wallet },
      { href: "/timesheets", label: "Timesheets", icon: Clock },
    ],
  },
  {
    label: "Governance",
    items: [
      { href: "/review", label: "Review", icon: ListChecks },
      { href: "/change-control", label: "Change Control", icon: GitPullRequest },
      { href: "/decisions", label: "Decisions", icon: Gavel },
      { href: "/approvals", label: "Approvals", icon: ClipboardCheck },
      { href: "/trust", label: "Trust Center", icon: ShieldCheck },
      { href: "/tokens", label: "Tokens", icon: KeyRound },
      { href: "/email-previews", label: "Email previews", icon: Mail },
    ],
  },
];

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
