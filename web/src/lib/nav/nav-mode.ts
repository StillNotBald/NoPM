/**
 * Sidebar navigation mode (R-78, progressive disclosure).
 *
 * Two modes: "essentials" (7 core items) and "all" (every module, the
 * pre-R-78 default). Persistence mirrors appearance.ts's cookie pattern
 * exactly (per-device, `nopm_nav`, 1 year, path=/, samesite=lax) with a DB
 * mirror (`user_preferences.config.nav.mode`) so a signed-in non-demo
 * user's choice also follows their account to a new device — same
 * two-layer precedence density/dateDisplay already use.
 *
 * Framework-agnostic (no React, no next/headers, no DOM) so it's safe to
 * import from Server Components (the console layout) and Client Components
 * (the sidebar, the settings page) alike.
 */

export type NavMode = "essentials" | "all";

export const NAV_MODE_COOKIE_NAME = "nopm_nav";
export const NAV_MODE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

export function isNavMode(v: unknown): v is NavMode {
  return v === "essentials" || v === "all";
}

/**
 * Parses a raw cookie VALUE (as `next/headers` `cookies().get(name).value`
 * or a `document.cookie` substring hands it back) into a NavMode, or null
 * if absent/unrecognised. Unlike appearance.ts's prefs object, there is no
 * default to fall back to here — the caller decides what "no cookie" means
 * (see resolveInitialNavMode below), so an invalid/missing value yields
 * null rather than a hardcoded mode.
 */
export function parseNavModeCookie(raw: string | null | undefined): NavMode | null {
  if (!raw) return null;
  let value = raw;
  try {
    value = decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding — fall through and try `raw` verbatim.
  }
  return isNavMode(value) ? value : null;
}

/** Builds the full `document.cookie` assignment string (name + value + attributes). */
export function buildNavModeCookieHeader(mode: NavMode): string {
  return `${NAV_MODE_COOKIE_NAME}=${encodeURIComponent(mode)}; path=/; max-age=${NAV_MODE_COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}

/** Reads and parses the nav-mode cookie from a raw `document.cookie` string. */
export function readNavModeCookie(documentCookie: string): NavMode | null {
  const match = documentCookie
    .split("; ")
    .find((row) => row.startsWith(`${NAV_MODE_COOKIE_NAME}=`));
  if (!match) return null;
  return parseNavModeCookie(match.slice(NAV_MODE_COOKIE_NAME.length + 1));
}

/**
 * Resolves the mode to render on first paint, in precedence order:
 *
 *   1. `cookie` — an explicit per-device choice always wins, however it
 *      was set (this device's sidebar toggle or the Settings page).
 *   2. `dbMode` — the account's saved choice (`user_preferences.config.
 *      nav.mode`), so switching devices carries the choice over before
 *      this device ever writes its own cookie.
 *   3. `hasPrefsRow ? "all" : "essentials"` — no cookie and no saved nav
 *      mode. A brand-new account (no preferences row at all) gets
 *      Essentials, the point of progressive disclosure for a first
 *      impression. An EXISTING user who already has a preferences row —
 *      they've been using the full product, saved a column layout, dismissed
 *      the wizard, whatever — keeps "all" so nothing moves under them
 *      unannounced (ClickUp complaint #7: defaults changed on users without
 *      a way back). The shared demo login has no row of its own, so it
 *      shows Essentials — which is the point of the demo: a small,
 *      legible first impression, not all 23 items at once.
 */
export function resolveInitialNavMode(input: {
  cookie: NavMode | null;
  dbMode: NavMode | null | undefined;
  hasPrefsRow: boolean;
  isDemo: boolean;
}): NavMode {
  if (input.cookie) return input.cookie;
  if (isNavMode(input.dbMode)) return input.dbMode;
  return input.hasPrefsRow ? "all" : "essentials";
}
