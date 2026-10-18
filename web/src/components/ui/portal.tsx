"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

const subscribe = () => () => {};

/**
 * Renders `children` into `document.body`, outside every shell ancestor.
 *
 * Overlays opened from inside the app shell (notification sheet, Apps sheet,
 * keyboard-shortcuts dialog) go through here for two reasons the shell cannot
 * give them: (1) any ancestor with a filter/transform/backdrop-filter becomes
 * the containing block for `position: fixed` descendants, so a "fixed" sheet
 * would be laid out against that ancestor instead of the viewport; (2)
 * `useInertShell` makes `[data-app-shell]` inert while a sheet is open, which
 * would inert a sheet rendered inside it. React context still flows through.
 *
 * Renders nothing on the server and during hydration (`null`), then the real
 * tree on the client — overlays are only ever shown after a user action, so
 * there is no visible flash.
 */
export function Portal({ children }: { children: ReactNode }) {
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return mounted ? createPortal(children, document.body) : null;
}
