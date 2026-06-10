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
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function ClashFocusOpener({ clashes: _clashes, projectMap: _projectMap }: Props) {
  const { focusId, clear } = useFocusParam("clash");

  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(`clash-${focusId}`);
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
