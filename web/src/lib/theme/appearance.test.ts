/**
 * Appearance preferences (L-37/L-38/L-42) — codec round-trip, closed-set
 * validation/fallback, cookie header shape, and SSR html-attrs resolution.
 */
import { describe, it, expect } from "vitest";
import {
  APPEARANCE_MODES,
  FONT_SCALES,
  DENSITIES,
  DATE_DISPLAYS,
  APPEARANCE_COOKIE_NAME,
  APPEARANCE_COOKIE_MAX_AGE_SECONDS,
  DEFAULT_APPEARANCE,
  parseAppearancePrefs,
  serializeAppearancePrefs,
  buildAppearanceCookieHeader,
  readAppearanceCookie,
  resolveHtmlAttrs,
  mergeAppearanceWithDb,
  type AppearancePrefs,
} from "./appearance";

describe("appearance — defaults", () => {
  it("defaults to light mode (preserves pre-existing behavior for existing sessions)", () => {
    expect(DEFAULT_APPEARANCE.mode).toBe("light");
  });

  it("defaults to 100% / comfortable / absolute", () => {
    expect(DEFAULT_APPEARANCE.fontScale).toBe(100);
    expect(DEFAULT_APPEARANCE.density).toBe("comfortable");
    expect(DEFAULT_APPEARANCE.dateDisplay).toBe("absolute");
  });
});

describe("appearance — codec round trip", () => {
  it.each(
    APPEARANCE_MODES.flatMap((mode) =>
      DENSITIES.flatMap((density) =>
        DATE_DISPLAYS.flatMap((dateDisplay) =>
          FONT_SCALES.map((fontScale) => ({ mode, density, dateDisplay, fontScale })),
        ),
      ),
    ),
  )("round-trips %j through serialize -> parse", (prefs) => {
    const serialized = serializeAppearancePrefs(prefs);
    expect(parseAppearancePrefs(serialized)).toEqual(prefs);
  });

  it("round-trips through the full cookie header (encode -> extract -> parse)", () => {
    const prefs: AppearancePrefs = {
      mode: "dark",
      fontScale: 112.5,
      density: "compact",
      dateDisplay: "relative",
    };
    const header = buildAppearanceCookieHeader(prefs);
    // Simulate what `document.cookie` looks like with just this cookie set.
    const nameValue = header.split(";")[0];
    expect(readAppearanceCookie(nameValue)).toEqual(prefs);
  });

  it("parses the RAW encoded cookie VALUE directly — the shape `next/headers` cookies().get(name).value hands layout.tsx/register pages (no manual decode by the caller)", () => {
    const prefs: AppearancePrefs = {
      mode: "system",
      fontScale: 87.5,
      density: "compact",
      dateDisplay: "relative",
    };
    // What the server sees is exactly the cookie VALUE — still
    // percent-encoded, since the client wrote it with encodeURIComponent
    // and cookie values are never auto-decoded in transit.
    const encodedValue = buildAppearanceCookieHeader(prefs).split(";")[0].split("=")[1];
    expect(encodedValue).toContain("%7B"); // sanity: it really is still encoded
    expect(parseAppearancePrefs(encodedValue)).toEqual(prefs);
  });
});

describe("appearance — cookie header shape", () => {
  it("uses the one nopm_appearance cookie name, 1yr max-age, samesite=lax, path=/", () => {
    const header = buildAppearanceCookieHeader(DEFAULT_APPEARANCE);
    expect(header).toContain(`${APPEARANCE_COOKIE_NAME}=`);
    expect(header).toContain("path=/");
    expect(header).toContain(`max-age=${APPEARANCE_COOKIE_MAX_AGE_SECONDS}`);
    expect(header).toContain("samesite=lax");
    expect(APPEARANCE_COOKIE_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 365);
  });

  it("finds the appearance cookie among other cookies on the same document.cookie string", () => {
    const header = buildAppearanceCookieHeader({ ...DEFAULT_APPEARANCE, mode: "dark" });
    const nameValue = header.split(";")[0];
    const documentCookie = `some_other=1; ${nameValue}; another=2`;
    expect(readAppearanceCookie(documentCookie).mode).toBe("dark");
  });
});

describe("appearance — parse fallback (closed-set validation, per field)", () => {
  it("falls back to defaults entirely for a missing cookie", () => {
    expect(parseAppearancePrefs(undefined)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearancePrefs(null)).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearancePrefs("")).toEqual(DEFAULT_APPEARANCE);
  });

  it("falls back to defaults for unparseable JSON (never throws)", () => {
    expect(() => parseAppearancePrefs("{not json")).not.toThrow();
    expect(parseAppearancePrefs("{not json")).toEqual(DEFAULT_APPEARANCE);
  });

  it("falls back to defaults for a JSON non-object (array, string, number)", () => {
    expect(parseAppearancePrefs("[1,2,3]")).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearancePrefs('"dark"')).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearancePrefs("42")).toEqual(DEFAULT_APPEARANCE);
  });

  it("validates each field independently — one bad field doesn't blow away the good ones", () => {
    const raw = JSON.stringify({
      mode: "not-a-real-mode",
      fontScale: 999,
      density: "compact",
      dateDisplay: "relative",
    });
    expect(parseAppearancePrefs(raw)).toEqual({
      mode: DEFAULT_APPEARANCE.mode,
      fontScale: DEFAULT_APPEARANCE.fontScale,
      density: "compact",
      dateDisplay: "relative",
    });
  });

  it("defaults missing fields (partial/older cookie shape)", () => {
    expect(parseAppearancePrefs(JSON.stringify({ mode: "dark" }))).toEqual({
      ...DEFAULT_APPEARANCE,
      mode: "dark",
    });
  });

  it("never produces a value outside the closed registry, however adversarial the input", () => {
    const raw = JSON.stringify({
      mode: "<script>",
      fontScale: "100%",
      density: 1,
      dateDisplay: null,
    });
    const result = parseAppearancePrefs(raw);
    expect(APPEARANCE_MODES).toContain(result.mode);
    expect(FONT_SCALES).toContain(result.fontScale);
    expect(DENSITIES).toContain(result.density);
    expect(DATE_DISPLAYS).toContain(result.dateDisplay);
  });
});

describe("appearance — resolveHtmlAttrs", () => {
  it("light mode adds no theme class", () => {
    const { classNames } = resolveHtmlAttrs({ ...DEFAULT_APPEARANCE, mode: "light" });
    expect(classNames).not.toContain("dark");
    expect(classNames).not.toContain("theme-system");
  });

  it("dark mode adds the .dark class", () => {
    const { classNames } = resolveHtmlAttrs({ ...DEFAULT_APPEARANCE, mode: "dark" });
    expect(classNames).toContain("dark");
    expect(classNames).not.toContain("theme-system");
  });

  it("system mode adds .theme-system, NOT .dark (dark is a media query under that class)", () => {
    const { classNames } = resolveHtmlAttrs({ ...DEFAULT_APPEARANCE, mode: "system" });
    expect(classNames).toContain("theme-system");
    expect(classNames).not.toContain("dark");
  });

  it("compact density adds .density-compact; comfortable adds nothing", () => {
    expect(
      resolveHtmlAttrs({ ...DEFAULT_APPEARANCE, density: "compact" }).classNames,
    ).toContain("density-compact");
    expect(
      resolveHtmlAttrs({ ...DEFAULT_APPEARANCE, density: "comfortable" }).classNames,
    ).not.toContain("density-compact");
  });

  it("mode and density classes compose independently", () => {
    const { classNames } = resolveHtmlAttrs({
      mode: "dark",
      fontScale: 100,
      density: "compact",
      dateDisplay: "absolute",
    });
    expect(classNames.sort()).toEqual(["dark", "density-compact"].sort());
  });

  it("stamps font-size as a percent string for every registered scale", () => {
    for (const scale of FONT_SCALES) {
      expect(resolveHtmlAttrs({ ...DEFAULT_APPEARANCE, fontScale: scale }).style.fontSize).toBe(
        `${scale}%`,
      );
    }
  });
});

describe("mergeAppearanceWithDb — L-39 cookie<->DB merge precedence", () => {
  const cookiePrefs: AppearancePrefs = {
    mode: "dark",
    fontScale: 112.5,
    density: "comfortable",
    dateDisplay: "absolute",
  };

  it("DB wins over cookie for density/dateDisplay when signed in and NOT demo", () => {
    const merged = mergeAppearanceWithDb(
      cookiePrefs,
      { density: "compact", dateDisplay: "relative" },
      { isDemo: false },
    );
    expect(merged.density).toBe("compact");
    expect(merged.dateDisplay).toBe("relative");
  });

  it("mode and fontScale are NEVER overridden by DB — they are outside the user_preferences whitelist", () => {
    const merged = mergeAppearanceWithDb(
      cookiePrefs,
      { density: "compact", dateDisplay: "relative" },
      { isDemo: false },
    );
    expect(merged.mode).toBe(cookiePrefs.mode);
    expect(merged.fontScale).toBe(cookiePrefs.fontScale);
  });

  it("demo identity stays cookie-only, even if a DB config were somehow present", () => {
    const merged = mergeAppearanceWithDb(
      cookiePrefs,
      { density: "compact", dateDisplay: "relative" },
      { isDemo: true },
    );
    expect(merged).toEqual(cookiePrefs);
  });

  it("no DB row (null/undefined config) falls back to the cookie untouched", () => {
    expect(mergeAppearanceWithDb(cookiePrefs, null, { isDemo: false })).toEqual(cookiePrefs);
    expect(mergeAppearanceWithDb(cookiePrefs, undefined, { isDemo: false })).toEqual(cookiePrefs);
  });

  it("a partial DB config (only density set) only overrides that one field", () => {
    const merged = mergeAppearanceWithDb(cookiePrefs, { density: "compact" }, { isDemo: false });
    expect(merged.density).toBe("compact");
    expect(merged.dateDisplay).toBe(cookiePrefs.dateDisplay);
  });

  it("a corrupt/out-of-registry DB value falls back to the cookie's value for that field, never throws", () => {
    const merged = mergeAppearanceWithDb(
      cookiePrefs,
      { density: "ultra-compact", dateDisplay: 42 },
      { isDemo: false },
    );
    expect(merged.density).toBe(cookiePrefs.density);
    expect(merged.dateDisplay).toBe(cookiePrefs.dateDisplay);
  });

  it("an empty DB config object changes nothing", () => {
    expect(mergeAppearanceWithDb(cookiePrefs, {}, { isDemo: false })).toEqual(cookiePrefs);
  });
});
