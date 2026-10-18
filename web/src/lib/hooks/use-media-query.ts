"use client";

import { useEffect, useState } from "react";

/**
 * Breakpoint queries matching the Tailwind defaults this codebase already
 * uses (sm 640 / md 768 / lg 1024). Kept as plain strings — pure data, no
 * DOM — so they can be unit-tested without jsdom (see use-media-query.test.ts).
 */
export const QUERY_BELOW_SM = "(max-width: 639.98px)";
export const QUERY_BELOW_MD = "(max-width: 767.98px)";
export const QUERY_BELOW_LG = "(max-width: 1023.98px)";
export const QUERY_MD_TO_LG = "(min-width: 768px) and (max-width: 1023.98px)";
export const QUERY_MD_UP = "(min-width: 768px)";
export const QUERY_LG_UP = "(min-width: 1024px)";

/**
 * SSR-safe media query hook. The server can't know the client's viewport, so
 * this returns `defaultValue` on the first (server + hydration) render — the
 * same value every time for a given call site — and only switches to the
 * live `matchMedia` result in an effect, after mount. That keeps hydration
 * markup identical between server and client (no mismatch warning) at the
 * cost of one extra render when the live value differs from the default.
 *
 * Callers that render mobile-only UI should pass `defaultValue: false` (the
 * default) so SSR renders the desktop/inline markup — matching this
 * codebase's existing convention of inline filters being the pre-JS baseline.
 */
export function useMediaQuery(query: string, defaultValue = false): boolean {
  const [matches, setMatches] = useState(defaultValue);

  useEffect(() => {
    const mql = window.matchMedia(query);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- house pattern (see saved-views-bar.tsx/bell.tsx): reconciles React state with the live matchMedia result on mount/query change, not a cascading re-render
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
