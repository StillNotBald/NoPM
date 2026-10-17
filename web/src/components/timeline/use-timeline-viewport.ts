"use client";

import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { scrollLeftForToday } from "@/lib/timeline/scale";

// useLayoutEffect warns during SSR; the scroll position only matters in the browser.
const useBrowserLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Live clientWidth of an element (0 until measured). Follows the element, not
 * the window, so it also reacts to the inspector panel opening, which narrows
 * the content column without changing the viewport. Drives the "Fit" views.
 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/**
 * Open a time-axis view (Gantt, portfolio roadmap, Mainline Subway) on TODAY
 * instead of on the data's first date, and hand back a "jump to today".
 *
 * - `todayX`: today's x within the scrollable content (null when today is
 *   outside the plotted range: nothing to open on, the view stays at the start).
 * - `insetPx`: width of a sticky column drawn over the left of the scroller
 *   (the Subway's project column), so today lands in the VISIBLE part.
 * - `resetKey`: re-opens on today whenever it changes (mount, view or fit
 *   toggle). Resizes and data refreshes never yank the scroll position.
 */
export function useOpenOnToday({
  scrollRef,
  todayX,
  contentPx,
  dayW,
  insetPx = 0,
  resetKey,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  todayX: number | null;
  contentPx: number;
  dayW: number;
  insetPx?: number;
  resetKey: string;
}): { scrollToToday: () => void } {
  const targetLeft = useCallback((): number | null => {
    const el = scrollRef.current;
    if (!el || todayX === null) return null;
    return scrollLeftForToday(todayX, Math.max(el.clientWidth - insetPx, 0), contentPx, dayW);
  }, [scrollRef, todayX, contentPx, dayW, insetPx]);

  // Keyed on resetKey only; every other input is read fresh at that moment.
  useBrowserLayoutEffect(() => {
    const el = scrollRef.current;
    const left = targetLeft();
    if (el && left !== null) el.scrollLeft = left;
  }, [resetKey]);

  const scrollToToday = useCallback(() => {
    const el = scrollRef.current;
    const left = targetLeft();
    if (!el || left === null) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el.scrollTo({ left, behavior: reduce ? "auto" : "smooth" });
  }, [scrollRef, targetLeft]);

  return { scrollToToday };
}
