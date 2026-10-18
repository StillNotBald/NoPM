"use client";

import { useSyncExternalStore } from "react";

/** Apple platforms show ⌘ where everyone else sees Ctrl. */
export function detectMac(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

const subscribe = () => () => {};

function clientIsMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return detectMac(nav.userAgentData?.platform ?? navigator.platform ?? "");
}

/**
 * Whether to label the command key "⌘" (true) or "Ctrl". Hydration-safe: the
 * server render and the first client render both say `false`, then React
 * re-renders with the real platform — no mismatch warning.
 */
export function useIsMac(): boolean {
  return useSyncExternalStore(subscribe, clientIsMac, () => false);
}

/** The label for the platform's command key. */
export const modKeyLabel = (isMac: boolean): string => (isMac ? "⌘" : "Ctrl");
