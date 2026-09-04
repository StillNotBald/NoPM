"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid, Minimize2, Rocket } from "lucide-react";
import { cn } from "@/lib/cn";
import { ProjectSwitcher } from "./project-switcher";
import { NAV_SECTIONS, visibleSections, hiddenCount, type NavItem } from "@/lib/nav/nav-config";
import {
  type NavMode,
  readNavModeCookie,
  buildNavModeCookieHeader,
} from "@/lib/nav/nav-mode";
import { usePreferences } from "@/lib/prefs/use-preferences";

export function Sidebar({
  collapsed = false,
  onNavigate,
  initialNavMode = "all",
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
  /** Server-resolved first-paint mode (R-78) — see nav-mode.ts's resolveInitialNavMode. */
  initialNavMode?: NavMode;
}) {
  const pathname = usePathname();
  const [mode, setMode] = useState<NavMode>(initialNavMode);
  const prefs = usePreferences();

  // Reconcile with the account's saved mode once preferences load — but
  // ONLY when this device has no explicit cookie of its own. An explicit
  // cookie (set by this toggle, on this device) always wins; a bare account
  // preference is meant to follow the user to a NEW device, not silently
  // override one that's already made its own choice.
  useEffect(() => {
    if (!prefs.ready) return;
    if (readNavModeCookie(document.cookie)) return;
    const dbMode = prefs.config.nav?.mode;
    if (dbMode && dbMode !== mode) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMode(dbMode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.ready, prefs.config.nav?.mode]);

  const sections = visibleSections(NAV_SECTIONS, mode, pathname);
  const hidden = hiddenCount(NAV_SECTIONS, mode, pathname);

  function toggleMode() {
    const next: NavMode = mode === "essentials" ? "all" : "essentials";
    setMode(next);
    document.cookie = buildNavModeCookieHeader(next);
    void prefs.update({ nav: { mode: next } });
  }

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
    <aside
      data-nav-mode={mode}
      className="flex h-full flex-col border-r border-border-subtle bg-sunken"
    >
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
        {sections.map((section, sectionIdx) => (
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

      {/* Essentials/all toggle */}
      <div className={cn("shrink-0 px-2 pt-1", collapsed && "flex justify-center px-0")}>
        {collapsed ? (
          <button
            type="button"
            onClick={toggleMode}
            data-testid="nav-mode-toggle"
            title={mode === "essentials" ? "Show all modules" : "Show essentials"}
            aria-label={mode === "essentials" ? "Show all modules" : "Show essentials"}
            className="grid h-9 w-9 place-items-center rounded-lg text-ink-secondary hover:bg-canvas/60"
          >
            {mode === "essentials" ? <LayoutGrid size={16} /> : <Minimize2 size={16} />}
          </button>
        ) : (
          <button
            type="button"
            onClick={toggleMode}
            data-testid="nav-mode-toggle"
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-ink-secondary hover:bg-canvas/60"
          >
            {mode === "essentials" ? <LayoutGrid size={16} className="text-ink-muted" /> : <Minimize2 size={16} className="text-ink-muted" />}
            <span>
              {mode === "essentials" ? "Show all modules" : "Show essentials"}
              {mode === "essentials" && hidden > 0 && (
                <span className="text-ink-muted"> · {hidden} more</span>
              )}
            </span>
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="flex shrink-0 items-center justify-between border-t border-border-subtle px-4 py-3 text-xs text-ink-muted">
          <Link
            href="/start"
            onClick={onNavigate}
            className="flex items-center gap-1.5 hover:text-ink"
          >
            <Rocket size={12} aria-hidden="true" />
            Getting started
          </Link>
          <span>stillnotbald.com</span>
        </div>
      )}
    </aside>
  );
}
