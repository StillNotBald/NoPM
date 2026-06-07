"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

type NavItem = { href: string; label: string };

const primary: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/projects", label: "Projects" },
  { href: "/risks", label: "Risks" },
  { href: "/issues", label: "Issues" },
  { href: "/clashes", label: "Clashes" },
  { href: "/resources", label: "Resources" },
  { href: "/budget", label: "Budget" },
];

const governance: NavItem[] = [
  { href: "/approvals", label: "Approvals" },
  { href: "/trust", label: "Trust Center" },
  { href: "/tokens", label: "Tokens" },
];

export function Sidebar() {
  const pathname = usePathname();
  const Item = ({ href, label }: NavItem) => (
    <Link
      href={href}
      className={cn(
        "block rounded-md px-3 py-2 text-sm transition-colors",
        pathname?.startsWith(href)
          ? "bg-sunken font-medium text-ink"
          : "text-ink-secondary hover:bg-sunken/60",
      )}
    >
      {label}
    </Link>
  );

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border-subtle bg-surface">
      <div className="flex items-center gap-2 px-5 py-4">
        <div className="grid h-7 w-7 place-items-center rounded-[8px] bg-accent text-sm font-semibold text-white">
          N
        </div>
        <span className="font-medium text-ink">NoPM</span>
      </div>
      <nav className="flex-1 space-y-0.5 px-3 py-2">
        {primary.map((n) => (
          <Item key={n.href} {...n} />
        ))}
        <div className="px-3 pb-1 pt-4 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
          Governance
        </div>
        {governance.map((n) => (
          <Item key={n.href} {...n} />
        ))}
      </nav>
      <div className="border-t border-border-subtle px-5 py-3 text-xs text-ink-muted">
        stillnotbald.com
      </div>
    </aside>
  );
}
