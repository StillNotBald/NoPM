"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Shared overlay behavior for RightPushPanel, Modal, the notification sheet,
 * the Apps sheet, the shortcuts dialog and the command palette (F1 — sheets
 * never locked body scroll or marked the app shell inert; touch and
 * screen-reader users could interact with the page behind an open sheet).
 *
 * useBodyScrollLock / useInertShell are scoped to below `lg` (1024px) on
 * purpose: at `lg`+, RightPushPanel is a non-modal push-column (no backdrop,
 * page stays interactive by design) and this must stay unchanged — the "≥lg
 * unchanged" rule the mobile shell spec calls out. Modal overlays therefore
 * ALSO trap Tab (useFocusTrap) so keyboard users cannot leave them at any width.
 *
 * Both lock hooks are reference-counted at module scope so nested sheets
 * (e.g. a Modal opened from inside an already-open RightPushPanel) don't undo
 * the lock/inert state until the LAST one closes.
 *
 * `useDialog` composes all of the above for a typical overlay.
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
 * just visually covered.
 *
 * The sheet itself MUST render outside `[data-app-shell]` or it inerts
 * itself: RightPushPanel, AssistantPanel, Modal and CommandPalette are
 * siblings of the shell; overlays opened from inside the shell (the
 * notification sheet, the Apps sheet, the shortcuts dialog) go through
 * `components/ui/portal.tsx` to `document.body`.
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

/** The element a dialog falls back to when the control that opened it is gone. */
export const MAIN_CONTENT_ID = "main-content";

/**
 * Captures whatever had focus right before `open` became true (the opener —
 * a row, a trigger button) and refocuses it once `open` goes back to false.
 * `initialFocusRef`, if given, receives focus on open (e.g. the sheet's
 * close button). `explicitOpenerRef`, if given, overrides the auto-captured
 * opener (for callers that already track their own trigger element).
 *
 * The opener is captured in a LAYOUT effect so it is read before any child's
 * passive autofocus effect (the command palette focuses its input on mount —
 * capturing afterwards would "return" focus to the input that is about to be
 * unmounted). If the opener no longer exists on close (it unmounted, e.g. a
 * palette command navigated away), focus falls back to `<main>` instead of
 * being stranded on a hidden control or `<body>`.
 */
export function useReturnFocus(
  open: boolean,
  initialFocusRef?: RefObject<HTMLElement | null>,
  explicitOpenerRef?: RefObject<HTMLElement | null>,
) {
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useLayoutEffect(() => {
    if (open) {
      // <body> means "nothing was focused" (the opener already unmounted, e.g. a
      // palette command that closes the palette and opens a panel): no opener.
      const active = document.activeElement as HTMLElement | null;
      openerRef.current = explicitOpenerRef?.current ?? (active && active !== document.body ? active : null);
    }
    // Keyed on `open` only: the refs are stable and their .current is read fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      const id = requestAnimationFrame(() => {
        initialFocusRef?.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    const opener = openerRef.current;
    const id = requestAnimationFrame(() => {
      if (opener && opener.isConnected && !opener.closest("[inert]")) {
        opener.focus();
        if (document.activeElement === opener) return;
      }
      document.getElementById(MAIN_CONTENT_ID)?.focus();
    });
    return () => cancelAnimationFrame(id);
    // Deliberately keyed on `open` only: `initialFocusRef`/`explicitOpenerRef`
    // are refs (stable identity) whose .current is read fresh on every fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

// ── useEscapeClose ──────────────────────────────────────────────────────────

type EscapeEntry = { close: () => void };
const escapeStack: EscapeEntry[] = [];
let escapeListening = false;

function onEscapeKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing) return;
  const top = escapeStack[escapeStack.length - 1];
  if (!top) return;
  top.close();
}

/**
 * Escape closes ONLY the top-most open overlay. Every overlay registers here
 * instead of adding its own document listener, so a palette opened over the
 * inspector closes first and one keypress never dismisses two layers.
 */
export function useEscapeClose(open: boolean, onClose: () => void) {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const entry: EscapeEntry = { close: () => closeRef.current() };
    escapeStack.push(entry);
    if (!escapeListening) {
      document.addEventListener("keydown", onEscapeKeyDown);
      escapeListening = true;
    }
    return () => {
      const i = escapeStack.indexOf(entry);
      if (i >= 0) escapeStack.splice(i, 1);
      if (escapeStack.length === 0 && escapeListening) {
        document.removeEventListener("keydown", onEscapeKeyDown);
        escapeListening = false;
      }
    };
  }, [open]);
}

// ── useFocusTrap ────────────────────────────────────────────────────────────

const TABBABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(",");

/** Pure wrap-around rule for Tab inside a trap; returns the element to focus, or null to let the browser move focus. */
export function trapTarget<T>(
  tabbables: readonly T[],
  active: T | null,
  shift: boolean,
  fallback: T | null = null,
): T | null {
  if (tabbables.length === 0) return fallback;
  const first = tabbables[0];
  const last = tabbables[tabbables.length - 1];
  const i = active === null ? -1 : tabbables.indexOf(active);
  if (i === -1) return shift ? last : first; // focus is outside (or on the container): pull it in
  if (shift && i === 0) return last;
  if (!shift && i === tabbables.length - 1) return first;
  return null;
}

function tabbablesWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter(
    (el) =>
      !el.closest("[inert]") &&
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== "hidden",
  );
}

const trapStack: symbol[] = [];

/**
 * Keeps Tab / Shift+Tab inside `containerRef` while `active`. Only the
 * top-most trap acts (a Modal opened over a trapped sheet takes over, then
 * hands back). Give the container `tabIndex={-1}` so it can hold focus when
 * it has nothing tabbable.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const token = Symbol("focus-trap");
    trapStack.push(token);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || trapStack[trapStack.length - 1] !== token) return;
      const container = containerRef.current;
      if (!container) return;
      const target = trapTarget(
        tabbablesWithin(container),
        document.activeElement as HTMLElement | null,
        e.shiftKey,
        container,
      );
      if (target) {
        e.preventDefault();
        target.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const i = trapStack.indexOf(token);
      if (i >= 0) trapStack.splice(i, 1);
    };
  }, [active, containerRef]);
}

// ── useDialog ───────────────────────────────────────────────────────────────

/**
 * One call for a typical overlay: Escape (top-most only), Tab trap, focus
 * entry + return, and — when `sheet` — body scroll lock and shell inert below
 * `lg`. `containerRef` is the dialog element (give it `tabIndex={-1}`).
 */
export function useDialog({
  open,
  onClose,
  containerRef,
  initialFocusRef,
  openerRef,
  trap = true,
  sheet = false,
}: {
  open: boolean;
  onClose: () => void;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  openerRef?: RefObject<HTMLElement | null>;
  trap?: boolean;
  sheet?: boolean;
}) {
  useBodyScrollLock(open && sheet);
  useInertShell(open && sheet);
  useEscapeClose(open, onClose);
  useFocusTrap(containerRef, open && trap);
  useReturnFocus(open, initialFocusRef ?? containerRef, openerRef);
}
