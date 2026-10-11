"use client";

import { useEffect } from "react";
import { useFocusParam } from "@/lib/nav/use-focus-param";
import type { ClashRow } from "@/app/(console)/clashes/page";

interface Props {
  clashes: ClashRow[];
  projectMap: Record<string, string>;
}

/**
 * Reads ?clash=<id> and scrolls + highlights the matching row.
 * Clashes have no inspector detail panel, so we just surface the row.
 * Renders null — purely a side-effect component.
 *
 * The register (F5) renders BOTH a <md card (`id="clash-m-<id>"`) and a ≥md
 * table row (`id="clash-<id>"`) at all times, toggling visibility with
 * Tailwind's `hidden`/`md:hidden` rather than unmounting either — so both
 * ids exist in the DOM simultaneously. `offsetParent === null` is the
 * cheapest reliable "is this the display:none one" check, letting us pick
 * whichever copy is actually on screen at the current viewport.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function ClashFocusOpener({ clashes: _clashes, projectMap: _projectMap }: Props) {
  const { focusId, clear } = useFocusParam("clash");

  useEffect(() => {
    if (!focusId) return;
    const desktopEl = document.getElementById(`clash-${focusId}`);
    const mobileEl = document.getElementById(`clash-m-${focusId}`);
    const el =
      (desktopEl && desktopEl.offsetParent !== null && desktopEl) ||
      (mobileEl && mobileEl.offsetParent !== null && mobileEl) ||
      desktopEl ||
      mobileEl;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Apply a brief highlight ring using a temporary class
      el.classList.add("ring-2", "ring-accent", "ring-inset");
      const timer = setTimeout(() => {
        el.classList.remove("ring-2", "ring-accent", "ring-inset");
        clear();
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [focusId, clear]);

  return null;
}
