"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_APPEARANCE,
  readAppearanceCookie,
  mergeAppearanceWithDb,
  type DateDisplay,
} from "@/lib/theme/appearance";
import { usePreferences } from "@/lib/prefs/use-preferences";

/**
 * Client-side read of the `dateDisplay` appearance preference.
 *
 * THREE-pass pattern (extended for L-39, R-78 sources pass 3 from the
 * shared prefs store instead of its own GET): render the SSR-safe default
 * on the first pass (server and client agree — no hydration mismatch), read
 * the real cookie in an effect after mount (same as before), then — once
 * the shared GET /api/me/preferences the whole console shares has resolved
 * — check for a signed-in non-demo DB override and let it win if present
 * (mergeAppearanceWithDb, same precedence layout.tsx applies server-side).
 * The initial "absolute" flash is a no-op for most visitors since absolute
 * is also the default preference; the DB pass (when it applies) resolves a
 * beat after the cookie pass, same tradeoff the cookie pass already accepts
 * vs. the SSR default.
 *
 * The store's own GET is best-effort and fail-soft: an anonymous visitor or
 * a network error leaves `prefs.config` empty, so the merge is a no-op and
 * the cookie value stands — this hook NEVER throws and NEVER blocks
 * rendering on the network call.
 *
 * Shared by every Client Component date surface (task lists, dashboard) so
 * the relative/absolute choice is read in exactly one place, not re-forked
 * per page.
 */
export function useDateDisplayPref(): DateDisplay {
  const [pref, setPref] = useState<DateDisplay>(DEFAULT_APPEARANCE.dateDisplay);
  const prefs = usePreferences();

  useEffect(() => {
    const cookiePrefs = readAppearanceCookie(document.cookie);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPref(cookiePrefs.dateDisplay);
  }, []);

  useEffect(() => {
    if (!prefs.ready) return;
    const cookiePrefs = readAppearanceCookie(document.cookie);
    const merged = mergeAppearanceWithDb(cookiePrefs, prefs.config, { isDemo: prefs.demo });
    if (merged.dateDisplay !== cookiePrefs.dateDisplay) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPref(merged.dateDisplay);
    }
  }, [prefs.ready, prefs.config, prefs.demo]);

  return pref;
}
