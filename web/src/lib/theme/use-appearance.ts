"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_APPEARANCE,
  readAppearanceCookie,
  mergeAppearanceWithDb,
  type AppearancePrefs,
  type DateDisplay,
} from "@/lib/theme/appearance";

/**
 * Client-side read of the `dateDisplay` appearance preference.
 *
 * THREE-pass pattern (extended for L-39): render the SSR-safe default on the
 * first pass (server and client agree — no hydration mismatch), read the
 * real cookie in an effect after mount (same as before), then — fire and
 * forget — check GET /api/me/preferences for a signed-in non-demo DB
 * override and let it win if present (mergeAppearanceWithDb, same
 * precedence layout.tsx applies server-side). The initial "absolute" flash
 * is a no-op for most visitors since absolute is also the default
 * preference; the DB pass (when it applies) resolves a beat after the
 * cookie pass, same tradeoff the cookie pass already accepts vs. the
 * SSR default.
 *
 * The fetch is best-effort: an anonymous visitor gets a 401 (harmless,
 * swallowed), a token caller can't reach this hook at all (client-only),
 * and any network/server error leaves the cookie value in place — this
 * hook NEVER throws and NEVER blocks rendering on the network call.
 *
 * Shared by every Client Component date surface (task lists, dashboard) so
 * the relative/absolute choice is read in exactly one place, not re-forked
 * per page.
 */
export function useDateDisplayPref(): DateDisplay {
  const [pref, setPref] = useState<DateDisplay>(DEFAULT_APPEARANCE.dateDisplay);

  useEffect(() => {
    const cookiePrefs = readAppearanceCookie(document.cookie);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPref(cookiePrefs.dateDisplay);

    let cancelled = false;
    fetch("/api/me/preferences")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { data?: { config?: { dateDisplay?: unknown }; demo?: boolean } } | null) => {
        if (cancelled || !json?.data) return;
        const merged: AppearancePrefs = mergeAppearanceWithDb(
          cookiePrefs,
          json.data.config ?? null,
          { isDemo: Boolean(json.data.demo) },
        );
        if (merged.dateDisplay !== cookiePrefs.dateDisplay) setPref(merged.dateDisplay);
      })
      .catch(() => {
        // Best-effort — anonymous 401, network error, etc. Cookie value stands.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return pref;
}
