"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutGrid, Plus, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { ALL_NAV_ITEMS, pendingByHref, filterNavItemsByRole, type NavItem } from "@/lib/nav/nav-config";
import { useMyRole } from "@/lib/nav/use-my-role";
import type { PendingCounts } from "@/lib/governance/pending-counts";
import { usePreferences } from "@/lib/prefs/use-preferences";
import { NavBadge } from "./nav-badge";
import { isActiveRoute } from "./active-route";
import { Portal } from "@/components/ui/portal";
import { useDialog } from "@/lib/hooks/use-sheet";

export type Item = NavItem;

// Every destination available to the shortcut bar — the same list (and the
// same labels/icons) the sidebar and command palette use.
const ALL_ITEMS: Item[] = ALL_NAV_ITEMS;

const DEFAULT_SHORTCUTS = ["/dashboard", "/projects", "/risks", "/approvals"];
const MAX_SHORTCUTS = 4; // iOS tab bar: 4 shortcuts + Apps = 5 slots
const STORAGE_KEY = "nopm.bottomnav.shortcuts";

const byHref = (href: string) => ALL_ITEMS.find((i) => i.href === href);

const sanitize = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.filter((h): h is string => typeof h === "string" && !!byHref(h)).slice(0, MAX_SHORTCUTS)
    : [];


// dnd-kit only loads when a viewer opens Edit mode — see bottom-nav-sortable.tsx.
// The loading fallback is a plain (non-draggable) skeleton grid so there is no
// layout jump while the chunk streams in; it swaps for the real drag UI once
// mounted (which receives the live items/handlers as normal props).
const BottomNavSortable = dynamic(() => import("./bottom-nav-sortable"), {
  ssr: false,
  loading: () => <StaticShortcutSkeleton />,
});

function StaticShortcutSkeleton() {
  return (
    <div className="grid grid-cols-4 gap-1 px-1 sm:grid-cols-5" aria-hidden="true">
      {Array.from({ length: MAX_SHORTCUTS }).map((_, i) => (
        <div key={i} className="animate-pulse rounded-xl bg-accent/10 py-3">
          <div className="mx-auto h-[22px] w-[22px] rounded bg-accent/20" />
        </div>
      ))}
    </div>
  );
}

/**
 * iOS-style bottom bar — mobile + tablet only (sidebar takes over at lg).
 * Shortcut slots are user-customizable: tap Apps → Edit to drag-reorder and
 * pin/unpin up to 4 shortcuts. Persisted to the account preferences
 * (`nav.shortcuts`) so they follow the user across devices; localStorage is
 * the fallback for anonymous/demo sessions or when prefs are unavailable.
 */
export function BottomNav({ pendingCounts = null }: { pendingCounts?: PendingCounts | null }) {
  const pathname = usePathname();
  const prefs = usePreferences();
  const pending = pendingByHref(pendingCounts);
  const pendingTotal = pendingCounts?.total ?? 0;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [shortcuts, setShortcuts] = useState<string[]>(DEFAULT_SHORTCUTS);

  // hydrate saved shortcuts after mount (avoids SSR mismatch): device-local
  // first (instant, works signed-out), then the account's saved list wins once
  // preferences load.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const valid = sanitize(JSON.parse(raw));
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (valid.length) setShortcuts(valid);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const accountShortcuts = prefs.config.nav?.shortcuts;
  useEffect(() => {
    if (!prefs.ready || !accountShortcuts) return;
    const valid = sanitize(accountShortcuts);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (valid.length) setShortcuts(valid);
  }, [prefs.ready, accountShortcuts]);

  const save = useCallback(
    (next: string[]) => {
      setShortcuts(next);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      // Account persistence (the store skips the PUT for the shared demo identity).
      void prefs.update({ nav: { shortcuts: next } });
    },
    [prefs.update],
  );

  const pin = (href: string) => {
    if (!shortcuts.includes(href) && shortcuts.length < MAX_SHORTCUTS) save([...shortcuts, href]);
  };
  const unpin = (href: string) => save(shortcuts.filter((h) => h !== href));

  const role = useMyRole();
  const visibleItems = filterNavItemsByRole(ALL_ITEMS, role);
  const barItems = filterNavItemsByRole(shortcuts.map(byHref).filter(Boolean) as Item[], role);
  const unpinned = visibleItems.filter((i) => !shortcuts.includes(i.href));
  const atCap = shortcuts.length >= MAX_SHORTCUTS;
  const isActive = (href: string) => isActiveRoute(href, pathname);

  const closeSheet = useCallback(() => {
    setOpen(false);
    setEditing(false);
  }, []);

  // The Apps sheet is a real modal dialog: Escape, Tab trap, scroll lock, shell
  // inert (it renders through <Portal>, outside [data-app-shell], so it does
  // not inert itself), focus into the sheet on open and back to "Apps" on close.
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const appsBtnRef = useRef<HTMLButtonElement>(null);
  useDialog({
    open,
    onClose: closeSheet,
    containerRef: sheetRef,
    initialFocusRef: closeBtnRef,
    openerRef: appsBtnRef,
    sheet: true,
  });

  return (
    <>
      {/* expanded app sheet */}
      {open && (
        <Portal>
          <div
            data-shell-chrome
            className="fixed inset-0 z-50 bg-black/30 lg:hidden"
            onClick={closeSheet}
          >
            <div
              ref={sheetRef}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-label="All apps"
              className="absolute inset-x-0 bottom-0 max-h-[82vh] overflow-y-auto rounded-t-xl bg-surface p-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-lg focus:outline-none"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-sm font-semibold text-ink">Apps</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setEditing((v) => !v)}
                    className={cn(
                      "focus-ring min-h-11 rounded-md px-3 py-1.5 text-sm font-medium",
                      editing ? "bg-accent text-accent-ink" : "text-accent hover:bg-well",
                    )}
                  >
                    {editing ? "Done" : "Edit"}
                  </button>
                  <button
                    ref={closeBtnRef}
                    type="button"
                    onClick={closeSheet}
                    className="focus-ring grid h-11 w-11 place-items-center rounded-md text-ink-secondary hover:bg-well"
                    aria-label="Close"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>

            {editing ? (
              <>
                {/* pinned shortcuts — drag to reorder */}
                <div className="px-3 pb-1 pt-1">
                  <p className="text-xs font-medium text-ink-secondary">
                    Your shortcuts
                    <span className="ml-2 font-normal text-ink-muted">
                      drag to reorder · {shortcuts.length}/{MAX_SHORTCUTS}
                    </span>
                  </p>
                </div>
                {barItems.length > 0 ? (
                  <BottomNavSortable
                    items={barItems}
                    order={shortcuts}
                    onReorder={save}
                    onRemove={unpin}
                  />
                ) : (
                  <p className="px-3 py-4 text-center text-xs text-ink-muted">
                    No shortcuts pinned — add some below.
                  </p>
                )}

                {/* add more */}
                <div className="mt-1 px-3 pb-1 pt-3">
                  <p className="text-xs font-medium text-ink-secondary">
                    Add to bar
                    {atCap && <span className="ml-2 font-normal text-ink-muted">remove one first</span>}
                  </p>
                </div>
                <div className="grid grid-cols-4 gap-1 px-1 pb-1 sm:grid-cols-5">
                  {unpinned.map(({ href, label, icon: Icon }) => (
                    <button
                      key={href}
                      type="button"
                      onClick={() => pin(href)}
                      disabled={atCap}
                      className={cn(
                        "focus-ring relative flex flex-col items-center gap-1.5 rounded-xl py-3 text-[11px] text-ink-secondary",
                        atCap ? "opacity-40" : "hover:bg-well",
                      )}
                    >
                      <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full border border-border-strong text-ink-muted">
                        <Plus size={11} strokeWidth={3} />
                      </span>
                      <Icon size={22} />
                      <span className="max-w-full truncate px-1 text-center leading-tight">{label}</span>
                    </button>
                  ))}
                  {unpinned.length === 0 && (
                    <p className="col-span-full px-3 py-4 text-center text-xs text-ink-muted">
                      Everything is pinned.
                    </p>
                  )}
                </div>
              </>
            ) : (
              /* browse mode — tap to navigate */
              <div className="grid grid-cols-4 gap-1 px-1 pb-1 sm:grid-cols-5">
                {visibleItems.map(({ href, label, icon: Icon }) => {
                  const active = isActive(href);
                  return (
                    <Link
                      key={href}
                      href={href}
                      onClick={closeSheet}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "focus-ring relative flex flex-col items-center gap-1.5 rounded-xl py-3 text-[11px]",
                        active ? "bg-well text-accent" : "text-ink-secondary hover:bg-well",
                      )}
                    >
                      <Icon size={22} />
                      <span className="max-w-full truncate px-1 text-center leading-tight">{label}</span>
                      <NavBadge count={pending[href] ?? 0} className="absolute right-2 top-1" />
                    </Link>
                  );
                })}
              </div>
            )}
            </div>
          </div>
        </Portal>
      )}

      {/* the bar */}
      <nav data-shell-chrome aria-label="Primary" className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border-subtle bg-canvas pb-[env(safe-area-inset-bottom)] lg:hidden">
        {barItems.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "focus-ring-inset relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px]",
                active ? "text-accent" : "text-ink-muted",
              )}
            >
              <NavBadge count={pending[href] ?? 0} className="absolute right-1/4 top-0.5" />
              <Icon size={22} strokeWidth={active ? 2.2 : 2} />
              <span className="max-w-full truncate px-0.5">{label}</span>
            </Link>
          );
        })}
        <button
          ref={appsBtnRef}
          type="button"
          onClick={() => setOpen(true)}
          className="focus-ring-inset relative flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] text-ink-muted"
          aria-label="All apps"
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <NavBadge count={pendingTotal} className="absolute right-1/4 top-0.5" />
          <LayoutGrid size={22} />
          <span>Apps</span>
        </button>
      </nav>
    </>
  );
}
