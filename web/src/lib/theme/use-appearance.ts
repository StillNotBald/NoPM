"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_APPEARANCE,
  readAppearanceCookie,
  type DateDisplay,
} from "@/lib/theme/appearance";

/**
 * Client-side read of the `dateDisplay` appearance preference.
 *
 * Same two-pass pattern as ThemeToggle: render the SSR-safe default on the
 * first pass (server and client agree — no hydration mismatch), then read
 * the real cookie in an effect after mount. The initial "absolute" flash is
 * a no-op for most visitors since absolute is also the default preference.
 *
 * Shared by every Client Component date surface (task lists, dashboard) so
 * the relative/absolute choice is read in exactly one place, not re-forked
 * per page.
 */
export function useDateDisplayPref(): DateDisplay {
  const [pref, setPref] = useState<DateDisplay>(DEFAULT_APPEARANCE.dateDisplay);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPref(readAppearanceCookie(document.cookie).dateDisplay);
  }, []);

  return pref;
}
