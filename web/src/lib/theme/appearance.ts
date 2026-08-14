/**
 * Appearance preferences — a CLOSED preset registry.
 *
 * L-37/L-38/L-42. These are per-user DISPLAY preferences, not governance
 * state (owner-presented constitutional carve-out — see
 * docs/adr/0009-user-preferences-unaudited.md): no free-form CSS, no color
 * picker, no DB row, no audit_log entry. Everything here is a closed set of
 * pre-approved presets so the "governance is invisible but never bypassable"
 * line never gets anywhere near this file — there is nothing to govern,
 * because there is nothing the user can express beyond these four dials.
 *
 * Persistence is ONE cookie (`nopm_appearance`, JSON, 1 year, samesite=lax)
 * — per-device/per-browser, not per-account. That is deliberate: the shared
 * demo login is a single Supabase identity used by many real visitors
 * (lesson: feedback_shared-demo-identity-persistence.md — per-user state
 * under a shared login leaks across visitors unless it is scoped to the
 * visitor's own device). A cookie never crosses devices or browsers, so two
 * people on the shared demo login never see each other's appearance choice.
 *
 * This module is framework-agnostic (no React, no `next/headers`, no DOM)
 * so it is safe to import from Server Components (layout.tsx, register
 * pages reading the cookie via `next/headers`) and from Client Components
 * (settings page, theme-toggle reading/writing `document.cookie`) alike.
 */

// ── Closed preset registry ──────────────────────────────────────────────────

export const APPEARANCE_MODES = ["system", "light", "dark"] as const;
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];

export const FONT_SCALES = [87.5, 100, 112.5, 125] as const;
export type FontScale = (typeof FONT_SCALES)[number];

export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const DATE_DISPLAYS = ["absolute", "relative"] as const;
export type DateDisplay = (typeof DATE_DISPLAYS)[number];

export interface AppearancePrefs {
  mode: AppearanceMode;
  fontScale: FontScale;
  density: Density;
  dateDisplay: DateDisplay;
}

/**
 * Default mode is LIGHT, not "system" — this preserves current behavior for
 * every existing session. layout.tsx today renders light unless the old
 * `theme` cookie says `dark`; nothing before this change ever inferred from
 * OS preference. Introducing appearance prefs must not silently flip an
 * existing user's app to dark just because their OS happens to be dark.
 */
export const DEFAULT_APPEARANCE: AppearancePrefs = {
  mode: "light",
  fontScale: 100,
  density: "comfortable",
  dateDisplay: "absolute",
};

export const APPEARANCE_COOKIE_NAME = "nopm_appearance";
export const APPEARANCE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

/** Legacy cookie (light/dark only) — read as a fallback for existing sessions. */
export const LEGACY_THEME_COOKIE_NAME = "theme";

// ── Validation helpers (closed sets only — anything else falls back) ───────

function isAppearanceMode(v: unknown): v is AppearanceMode {
  return typeof v === "string" && (APPEARANCE_MODES as readonly string[]).includes(v);
}

function isFontScale(v: unknown): v is FontScale {
  return typeof v === "number" && (FONT_SCALES as readonly number[]).includes(v);
}

function isDensity(v: unknown): v is Density {
  return typeof v === "string" && (DENSITIES as readonly string[]).includes(v);
}

function isDateDisplay(v: unknown): v is DateDisplay {
  return typeof v === "string" && (DATE_DISPLAYS as readonly string[]).includes(v);
}

/**
 * Parses a raw cookie VALUE (as `next/headers` `cookies().get(name).value`
 * or a `document.cookie` substring hands it back — i.e. still
 * `encodeURIComponent`-encoded, per `buildAppearanceCookieHeader` below)
 * into a fully-populated AppearancePrefs. Each field is validated
 * independently against its closed set and falls back to the default on
 * its own — a corrupt/partial/future-shaped/undecodable cookie never
 * throws and never produces an out-of-registry value.
 *
 * Decoding lives HERE (not in each caller) so every reader — layout.tsx,
 * the register pages, the client cookie hook, the settings page — agrees
 * on the wire format exactly once.
 */
export function parseAppearancePrefs(raw: string | null | undefined): AppearancePrefs {
  if (!raw) return { ...DEFAULT_APPEARANCE };
  let jsonText = raw;
  try {
    // Safe even if `raw` is already-decoded JSON (no `%` sequences to
    // transform) — decodeURIComponent is then a no-op passthrough.
    jsonText = decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding — fall through and try `raw` verbatim.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_APPEARANCE };
  const p = parsed as Record<string, unknown>;
  return {
    mode: isAppearanceMode(p.mode) ? p.mode : DEFAULT_APPEARANCE.mode,
    fontScale: isFontScale(p.fontScale) ? p.fontScale : DEFAULT_APPEARANCE.fontScale,
    density: isDensity(p.density) ? p.density : DEFAULT_APPEARANCE.density,
    dateDisplay: isDateDisplay(p.dateDisplay) ? p.dateDisplay : DEFAULT_APPEARANCE.dateDisplay,
  };
}

/** JSON-serializes prefs for the cookie VALUE (no attributes). */
export function serializeAppearancePrefs(prefs: AppearancePrefs): string {
  return JSON.stringify(prefs);
}

/**
 * Builds the full `document.cookie` assignment string (name + value +
 * attributes) for client-side writers (theme-toggle, settings page).
 * Mirrors the old theme-toggle's cookie write exactly (path=/, 1yr,
 * samesite=lax) — just JSON instead of a bare "dark"/"light" string.
 */
export function buildAppearanceCookieHeader(prefs: AppearancePrefs): string {
  const value = encodeURIComponent(serializeAppearancePrefs(prefs));
  return `${APPEARANCE_COOKIE_NAME}=${value}; path=/; max-age=${APPEARANCE_COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
}

/** Reads and decodes the appearance cookie from a raw `document.cookie` string. */
export function readAppearanceCookie(documentCookie: string): AppearancePrefs {
  const match = documentCookie
    .split("; ")
    .find((row) => row.startsWith(`${APPEARANCE_COOKIE_NAME}=`));
  if (!match) return { ...DEFAULT_APPEARANCE };
  // Pass the still-encoded value straight through — parseAppearancePrefs
  // owns decoding, same as it does for the `next/headers` server read path.
  return parseAppearancePrefs(match.slice(APPEARANCE_COOKIE_NAME.length + 1));
}

// ── SSR application (before first paint) ────────────────────────────────────

export interface ResolvedHtmlAttrs {
  /** Class names to add to the <html> element, in addition to the base classes. */
  classNames: string[];
  /** Inline style to stamp on <html> (font-size percent — no flash, no CLS). */
  style: { fontSize: string };
}

/**
 * Resolves an AppearancePrefs into what layout.tsx stamps on <html> before
 * first paint. `system` mode does NOT add a `dark` class — dark for system
 * mode is entirely a `prefers-color-scheme` media query in globals.css
 * scoped under `.theme-system` (SSR-safe: works even though the server
 * cannot know the visitor's OS theme, and it follows the OS live without a
 * client script). `dateDisplay` is not represented here — it is read
 * per-surface via formatByPref, not applied as a global class.
 */
export function resolveHtmlAttrs(prefs: AppearancePrefs): ResolvedHtmlAttrs {
  const classNames: string[] = [];
  if (prefs.mode === "dark") classNames.push("dark");
  else if (prefs.mode === "system") classNames.push("theme-system");
  if (prefs.density === "compact") classNames.push("density-compact");
  return { classNames, style: { fontSize: `${prefs.fontScale}%` } };
}
