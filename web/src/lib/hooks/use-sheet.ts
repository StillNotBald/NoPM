"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Shared sheet behavior for RightPushPanel and Modal (F1 — sheets never
 * locked body scroll or marked the app shell inert; touch and screen-reader
 * users could interact with the page behind an open sheet).
 *
 * Both hooks are scoped to below `lg` (1024px) on purpose: at `lg`+,
 * RightPushPanel is a non-modal push-column (no backdrop, page stays
 * interactive by design) and this must stay unchanged — the "≥lg unchanged"
 * rule the mobile shell spec calls out.
 *
 * Both hooks are reference-counted at module scope so nested sheets (e.g. a
 * Modal opened from inside an already-open RightPushPanel) don't undo the
 * lock/inert state until the LAST one closes.
 */

const isBelowLg = () =>
  typeof window !== "undefined" && !window.matchMedia("(min-width: 1024px)").matches;

// ── useBodyScrollLock ───────────────────────────────────────────────────────

type SavedBodyStyle = {
  position: string;
  top: string;
  left: string;
  right: string;
  width: string;
  overflow: string;
};

let scrollLockCount = 0;
let savedScrollY = 0;
let savedBodyStyle: SavedBodyStyle | null = null;

/**
 * Locks body scroll while `open` is true, below `lg`. Uses the
 * position:fixed + saved-scrollY technique (not `overflow: hidden` alone)
 * because iOS Safari does not reliably stop body scroll under a fixed
 * overlay otherwise; restores the exact scroll position on close.
 */
export function useBodyScrollLock(open: boolean) {
  useEffect(() => {
    if (!open || !isBelowLg()) return;

    if (scrollLockCount === 0) {
      const body = document.body;
      savedScrollY = window.scrollY;
      savedBodyStyle = {
        position: body.style.position,
        top: body.style.top,
        left: body.style.left,
        right: body.style.right,
        width: body.style.width,
        overflow: body.style.overflow,
      };
      body.style.position = "fixed";
      body.style.top = `-${savedScrollY}px`;
      body.style.left = "0";
      body.style.right = "0";
      body.style.width = "100%";
      body.style.overflow = "hidden";
    }
    scrollLockCount += 1;

    return () => {
      scrollLockCount = Math.max(0, scrollLockCount - 1);
      if (scrollLockCount === 0) {
        const body = document.body;
        const prev = savedBodyStyle;
        body.style.position = prev?.position ?? "";
        body.style.top = prev?.top ?? "";
        body.style.left = prev?.left ?? "";
        body.style.right = prev?.right ?? "";
        body.style.width = prev?.width ?? "";
        body.style.overflow = prev?.overflow ?? "";
        window.scrollTo(0, savedScrollY);
        savedBodyStyle = null;
      }
    };
  }, [open]);
}

// ── useInertShell ───────────────────────────────────────────────────────────

let inertCount = 0;

/**
 * Marks the app-shell's background region (`[data-app-shell]`, set in
 * app-shell.tsx) `inert` + `aria-hidden` while `open` is true, below `lg` —
 * so the sidebar, header, page content, and bottom nav are unreachable to
 * touch, mouse-wheel, and screen-reader users while a sheet covers them, not
 * just visually covered. The sheet itself renders outside `[data-app-shell]`
 * so it is never inerted by its own open state.
 */
export function useInertShell(open: boolean) {
  useEffect(() => {
    if (!open || !isBelowLg()) return;
    const shell = document.querySelector<HTMLElement>("[data-app-shell]");
    if (!shell) return;

    inertCount += 1;
    shell.setAttribute("inert", "");
    shell.setAttribute("aria-hidden", "true");

    return () => {
      inertCount = Math.max(0, inertCount - 1);
      if (inertCount === 0) {
        shell.removeAttribute("inert");
        shell.removeAttribute("aria-hidden");
      }
    };
  }, [open]);
}

// ── useReturnFocus ──────────────────────────────────────────────────────────

/**
 * Captures whatever had focus right before `open` became true (the opener —
 * a row, a trigger button) and refocuses it once `open` goes back to false.
 * `initialFocusRef`, if given, receives focus on open (e.g. the sheet's
 * close button). `explicitOpenerRef`, if given, overrides the auto-captured
 * opener (for callers that already track their own trigger element).
 */
export function useReturnFocus(
  open: boolean,
  initialFocusRef?: RefObject<HTMLElement | null>,
  explicitOpenerRef?: RefObject<HTMLElement | null>,
) {
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      openerRef.current = explicitOpenerRef?.current ?? (document.activeElement as HTMLElement | null);
      const id = requestAnimationFrame(() => {
        initialFocusRef?.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
    const opener = openerRef.current;
    if (opener && document.contains(opener)) {
      requestAnimationFrame(() => opener.focus());
    }
    // Deliberately keyed on `open` only: `initialFocusRef`/`explicitOpenerRef`
    // are refs (stable identity) whose .current is read fresh on every fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}
