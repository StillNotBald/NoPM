"use client";

/**
 * RightPushPanel — non-modal right-side panel that PUSHES the content column.
 *
 * Design contract (ported from a prior platform's RightPushPanel):
 *  - Slides in from the right edge; NO backdrop/overlay on desktop.
 *  - On desktop (lg+) the caller's <main> gets a right-margin via the exported
 *    PUSH_MARGIN / PUSH_MARGIN_NONE helpers so the columns sit side-by-side.
 *  - Below lg the panel becomes a takeover sheet: full-screen below md,
 *    bottom-sheet (top radius) between md and lg. Body scroll is locked and
 *    the app shell is marked `inert` while open (useBodyScrollLock /
 *    useInertShell) — background content is unreachable, not just covered.
 *  - Escape closes the top-most overlay (useEscapeClose); focus moves to the
 *    close button on open and returns to the opener on close, or to <main>
 *    when the opener is gone (useReturnFocus). No focus-trap — Tab may leave
 *    the panel at lg+, where it isn't modal.
 *  - While CLOSED the panel is `inert` + `invisible`: nothing in it is
 *    focusable or announced, and its shadow no longer bleeds into the
 *    viewport edge. (`aria-hidden` stays as the e2e open/closed signal.)
 *  - At lg+ it is exactly viewport-height (`lg:top-0 lg:bottom-0`): the body
 *    scrolls and the footer stays pinned, however tall the form is.
 *  - Expand/collapse toggle is shown when onToggleExpand is provided.
 */

import React, { type ReactNode } from "react";
import { useBodyScrollLock, useEscapeClose, useInertShell, useReturnFocus } from "@/lib/hooks/use-sheet";

// ── Public margin helpers ─────────────────────────────────────────────────────

/**
 * Apply to the <main> content column while the panel is open (and not expanded).
 * Matches the default panel width (28rem) + 0 breathing room.
 */
export const PUSH_MARGIN =
  "transition-[margin] duration-300 lg:mr-[28rem]";

/** Idle state — keeps the transition present so the spring-back is smooth. */
export const PUSH_MARGIN_NONE = "transition-[margin] duration-300";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface RightPushPanelProps {
  open: boolean;
  onClose: () => void;
  title: string;
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** Tailwind width class when NOT expanded, applied at lg+ only. Default: `"lg:w-[28rem]"`. */
  widthClass?: string;
  children: React.ReactNode;
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  /** Sticky footer slot for a primary action (e.g. "Apply" in a FilterSheet). */
  footer?: ReactNode;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function RightPushPanel({
  open,
  onClose,
  title,
  expanded = false,
  onToggleExpand,
  widthClass = "lg:w-[28rem]",
  children,
  returnFocusRef,
  footer,
}: RightPushPanelProps) {
  const closeBtnRef = React.useRef<HTMLButtonElement | null>(null);

  useBodyScrollLock(open);
  useInertShell(open);
  useReturnFocus(open, closeBtnRef, returnFocusRef);
  useEscapeClose(open, onClose);

  // Width / position — expanded fills the full viewport width at lg+; below
  // lg the panel is always full-width (full-screen or bottom-sheet).
  const sizeClasses = expanded ? "lg:left-0 lg:w-auto" : `w-full ${widthClass}`;

  return (
    <>
      {/* Backdrop below lg (full-screen sheet / bottom-sheet) — no backdrop at lg+ (push-column). */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/30 lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      <div
        role="dialog"
        aria-modal={false}
        aria-label={title}
        aria-hidden={!open}
        inert={!open}
        className={[
          "fixed z-50 flex flex-col",
          "bg-surface shadow-lg",
          // `translate` slides (Tailwind v4 translate-* sets the translate
          // property, not transform); visibility flips at once when opening
          // (so the close button can take focus) and after the slide when closing.
          "[transition-property:translate,visibility] [transition-duration:300ms,0s] ease-out",
          // <md: full-screen sheet
          "inset-0 border-0",
          // md–lg: bottom sheet with top radius
          "md:inset-x-0 md:inset-y-auto md:top-auto md:bottom-0 md:max-h-[88vh] md:rounded-t-xl md:border-t md:border-border-subtle",
          // ≥lg: right push-column, viewport-height-bound (top AND bottom pinned)
          "lg:top-0 lg:bottom-0 lg:right-0 lg:left-auto lg:max-h-none lg:rounded-none lg:border-l lg:border-t-0 lg:border-border-subtle",
          open
            ? "visible translate-x-0 translate-y-0 [transition-delay:0s,0s]"
            : "invisible translate-y-full [transition-delay:0s,300ms] lg:translate-y-0 lg:translate-x-full",
          sizeClasses,
        ].join(" ")}
      >
        {/* ── Header ──────────────────────────────────────────────────────────── */}
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4 pt-[env(safe-area-inset-top)]">
          <span className="truncate text-sm font-semibold text-ink">
            {title}
          </span>

          <div className="flex shrink-0 items-center gap-1">
            {/* Expand / collapse — desktop only */}
            {onToggleExpand && (
              <button
                type="button"
                onClick={onToggleExpand}
                aria-label={expanded ? "Collapse panel" : "Expand panel"}
                aria-pressed={expanded}
                className="focus-ring hidden h-8 w-8 place-items-center rounded-md text-ink-secondary hover:bg-sunken lg:grid"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.5}
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  {expanded ? (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M15 9h4.5M15 9V4.5M15 9l5.25-5.25M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25"
                    />
                  ) : (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9m11.25-5.25h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25v-4.5m0 4.5h-4.5m4.5 0L15 15M3.75 20.25h4.5m-4.5 0v-4.5m0 4.5L9 15"
                    />
                  )}
                </svg>
              </button>
            )}

            {/* Close — always visible; receives focus on open; 44px hit area */}
            <button
              ref={closeBtnRef}
              type="button"
              onClick={onClose}
              aria-label="Close panel"
              className="focus-ring grid h-11 w-11 place-items-center rounded-md text-ink-secondary hover:bg-sunken"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        {/* ── Body ────────────────────────────────────────────────────────────── */}
        <div
          className={[
            "min-h-0 flex-1 overflow-auto p-4",
            footer ? "" : "pb-[max(1rem,env(safe-area-inset-bottom))]",
          ].join(" ")}
        >
          {children}
        </div>

        {/* ── Footer (optional, sticky primary action) ───────────────────────── */}
        {footer && (
          <div className="shrink-0 border-t border-border-subtle p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </>
  );
}
