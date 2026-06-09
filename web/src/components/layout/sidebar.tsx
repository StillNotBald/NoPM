"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Inbox,
  ListTodo,
  LayoutDashboard,
  FolderKanban,
  Map,
  FileText,
  AlertTriangle,
  CircleAlert,
  Zap,
  Users,
  Wallet,
  ListChecks,
  GitPullRequest,
  Gavel,
  ClipboardCheck,
  ShieldCheck,
  KeyRound,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { ProjectSwitcher } from "./project-switcher";

type NavItem = { href: string; label: string; icon: LucideIcon };

type NavSection = {
  label: string;
  items: NavItem[];
};

const NAV_SECTIONS: NavSection[] = [
  {
    label: "Overview",
    items: [
      { href: "/my-work", label: "My Work", icon: Inbox },
      { href: "/my-tasks", label: "My Tasks", icon: ListTodo },
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    ],
  },
  {
    label: "Delivery",
    items: [
      { href: "/projects", label: "Projects", icon: FolderKanban },
      { href: "/portfolio", label: "Portfolio", icon: Map },
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
    ],
  },
];

export function Sidebar({
  collapsed = false,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  const Item = ({ href, label, icon: Icon }: NavItem) => {
    const active = pathname?.startsWith(href);
    return (
      <Link
        href={href}
        onClick={onNavigate}
        title={collapsed ? label : undefined}
        className={cn(
          "flex items-center gap-3 rounded-lg border-l-2 px-2.5 py-2 text-[13px] transition-colors",
          collapsed && "justify-center border-l-0 px-0",
          active
            ? "border-accent bg-canvas font-medium text-ink shadow-sm"
            : "border-transparent text-ink-secondary hover:bg-canvas/60",
        )}
      >
        <Icon size={18} className={active ? "text-ink" : "text-ink-muted"} strokeWidth={2} />
        {!collapsed && <span className="truncate">{label}</span>}
      </Link>
    );
  };

  return (
    <aside className="flex h-full flex-col border-r border-border-subtle bg-sunken">
      {/* Brand */}
      <div className={cn("flex h-14 shrink-0 items-center gap-2 px-4", collapsed && "justify-center px-0")}>
        {collapsed ? (
          <span className="grid h-7 w-7 place-items-center rounded-md bg-accent font-mono text-sm font-bold text-accent-ink">
            N
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-4 w-[3px] animate-pulse rounded-[1px] bg-accent" />
            <span className="font-mono font-semibold tracking-tight text-ink">nopm</span>
          </span>
        )}
      </div>

      {/* Project switcher */}
      <div className={cn("shrink-0 px-2 pb-2", collapsed && "flex justify-center px-0")}>
        <ProjectSwitcher collapsed={collapsed} />
      </div>

      {/* Nav sections */}
      <nav className="flex-1 overflow-y-auto px-2 py-1">
        {NAV_SECTIONS.map((section, sectionIdx) => (
          <div key={section.label}>
            {/* Section divider / label */}
            {sectionIdx > 0 && (
              <>
                {collapsed ? (
                  <div className="mx-3 my-2 border-t border-border-subtle" />
                ) : (
                  <div className="px-2.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                    {section.label}
                  </div>
                )}
              </>
            )}
            {/* First section label (no top margin) */}
            {sectionIdx === 0 && !collapsed && (
              <div className="px-2.5 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                {section.label}
              </div>
            )}
            <div className="space-y-0.5">
              {section.items.map((n) => (
                <Item key={n.href} {...n} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {!collapsed && (
        <div className="shrink-0 border-t border-border-subtle px-4 py-3 text-xs text-ink-muted">
          stillnotbald.com
        </div>
      )}
    </aside>
  );
}
