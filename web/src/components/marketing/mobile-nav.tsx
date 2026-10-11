"use client";

import { useEffect, useRef, useState } from "react";
import { useBodyScrollLock, useInertShell, useReturnFocus } from "@/lib/hooks/use-sheet";

export type MobileNavLink = {
  href: string;
  label: string;
};

/**
 * Marketing-page nav collapse (R-94 mobile pass). Below `md` the secondary
 * nav links live behind a 44px hamburger button that opens a simple sheet —
 * no dependency on the app-shell RightPushPanel/Modal (those are console-only
 * and off this page's scope), just the shared scroll-lock/inert/focus hooks
 * every other sheet in the product already uses, so behavior matches.
 */
export function MobileNavMenu({ links, className }: { links: MobileNavLink[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useBodyScrollLock(open);
  useInertShell(open);
  useReturnFocus(open, closeRef, triggerRef);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className={className}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="grid h-11 w-11 place-items-center rounded-md text-ink-secondary hover:bg-sunken hover:text-ink"
      >
        <MenuIcon />
      </button>

      {open && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="absolute inset-0 bg-ink/30"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Site menu"
            className="absolute inset-x-0 top-0 rounded-b-2xl border-b border-border-subtle bg-canvas shadow-lg"
          >
            <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
              <span className="text-sm font-medium text-ink">Menu</span>
              <button
                ref={closeRef}
                type="button"
                aria-label="Close menu"
                onClick={() => setOpen(false)}
                className="grid h-11 w-11 place-items-center rounded-md text-ink-secondary hover:bg-sunken hover:text-ink"
              >
                <CloseIcon />
              </button>
            </div>
            <nav className="flex flex-col px-4 py-2">
              {links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="flex min-h-[44px] items-center border-b border-border-subtle text-sm text-ink-secondary last:border-b-0 hover:text-ink"
                >
                  {link.label}
                </a>
              ))}
            </nav>
          </div>
        </div>
      )}
    </div>
  );
}

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <line x1="4" y1="4" x2="20" y2="20" />
      <line x1="20" y1="4" x2="4" y2="20" />
    </svg>
  );
}
