"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  FolderKanban,
  AlertTriangle,
  CircleAlert,
  Zap,
  Users,
  Wallet,
  ClipboardCheck,
  ShieldCheck,
  KeyRound,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

type NavItem = { href: string; label: string; icon: LucideIcon };

const primary: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/risks", label: "Risks", icon: AlertTriangle },
  { href: "/issues", label: "Issues", icon: CircleAlert },
  { href: "/clashes", label: "Clashes", icon: Zap },
  { href: "/resources", label: "Resources", icon: Users },
  { href: "/budget", label: "Budget", icon: Wallet },
];

const governance: NavItem[] = [
  { href: "/approvals", label: "Approvals", icon: ClipboardCheck },
  { href: "/trust", label: "Trust Center", icon: ShieldCheck },
  { href: "/tokens", label: "Tokens", icon: KeyRound },
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
          "flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
          collapsed && "justify-center px-0",
          active
            ? "bg-canvas font-medium text-ink shadow-sm"
            : "text-ink-secondary hover:bg-canvas/60",
        )}
      >
        <Icon size={18} className={active ? "text-accent" : "text-ink-muted"} strokeWidth={2} />
        {!collapsed && <span className="truncate">{label}</span>}
      </Link>
    );
  };

  return (
    <aside className="flex h-full flex-col border-r border-border-subtle bg-sunken">
      <div className={cn("flex h-14 shrink-0 items-center gap-2 px-4", collapsed && "justify-center px-0")}>
        <div className="grid h-7 w-7 place-items-center rounded-[7px] bg-accent text-sm font-semibold text-white">
          N
        </div>
        {!collapsed && <span className="font-semibold tracking-tight text-ink">NoPM</span>}
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
        {primary.map((n) => (
          <Item key={n.href} {...n} />
        ))}
        {!collapsed ? (
          <div className="px-2.5 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            Governance
          </div>
        ) : (
          <div className="mx-3 my-3 border-t border-border-subtle" />
        )}
        {governance.map((n) => (
          <Item key={n.href} {...n} />
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
