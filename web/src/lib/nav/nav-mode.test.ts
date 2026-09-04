/**
 * Nav mode (R-78) — cookie codec, round-trip, and first-paint precedence.
 */
import { describe, it, expect } from "vitest";
import {
  NAV_MODE_COOKIE_NAME,
  NAV_MODE_COOKIE_MAX_AGE_SECONDS,
  isNavMode,
  parseNavModeCookie,
  buildNavModeCookieHeader,
  readNavModeCookie,
  resolveInitialNavMode,
  type NavMode,
} from "./nav-mode";

describe("isNavMode", () => {
  it("accepts essentials and all", () => {
    expect(isNavMode("essentials")).toBe(true);
    expect(isNavMode("all")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isNavMode("full")).toBe(false);
    expect(isNavMode(null)).toBe(false);
    expect(isNavMode(undefined)).toBe(false);
    expect(isNavMode(1)).toBe(false);
    expect(isNavMode("")).toBe(false);
  });
});

describe("parseNavModeCookie", () => {
  it("parses a valid raw value", () => {
    expect(parseNavModeCookie("essentials")).toBe("essentials");
    expect(parseNavModeCookie("all")).toBe("all");
  });

  it("returns null for missing/invalid values", () => {
    expect(parseNavModeCookie(null)).toBeNull();
    expect(parseNavModeCookie(undefined)).toBeNull();
    expect(parseNavModeCookie("")).toBeNull();
    expect(parseNavModeCookie("bogus")).toBeNull();
  });

  it("decodes a percent-encoded value", () => {
    expect(parseNavModeCookie(encodeURIComponent("essentials"))).toBe("essentials");
  });
});

describe("nav mode cookie header + round trip", () => {
  it.each(["essentials", "all"] as const)("round-trips %s through header -> read", (mode) => {
    const header = buildNavModeCookieHeader(mode);
    expect(header).toContain(`${NAV_MODE_COOKIE_NAME}=`);
    expect(header).toContain(`max-age=${NAV_MODE_COOKIE_MAX_AGE_SECONDS}`);
    expect(header).toContain("path=/");
    expect(header).toContain("samesite=lax");
    const nameValue = header.split(";")[0];
    expect(readNavModeCookie(nameValue)).toBe(mode);
  });

  it("readNavModeCookie returns null when the cookie isn't present", () => {
    expect(readNavModeCookie("other=1; foo=bar")).toBeNull();
  });

  it("readNavModeCookie finds the cookie among others", () => {
    const header = buildNavModeCookieHeader("essentials");
    const nameValue = header.split(";")[0];
    expect(readNavModeCookie(`foo=bar; ${nameValue}; baz=qux`)).toBe("essentials");
  });
});

describe("resolveInitialNavMode — precedence", () => {
  const base = { cookie: null as NavMode | null, dbMode: null as NavMode | null | undefined, hasPrefsRow: false, isDemo: false };

  it("cookie wins over everything", () => {
    expect(
      resolveInitialNavMode({ ...base, cookie: "all", dbMode: "essentials", hasPrefsRow: true }),
    ).toBe("all");
    expect(
      resolveInitialNavMode({ ...base, cookie: "essentials", dbMode: "all", hasPrefsRow: true }),
    ).toBe("essentials");
  });

  it("dbMode wins when there is no cookie", () => {
    expect(resolveInitialNavMode({ ...base, cookie: null, dbMode: "all" })).toBe("all");
    expect(resolveInitialNavMode({ ...base, cookie: null, dbMode: "essentials" })).toBe("essentials");
  });

  it("a brand-new account (no row) with no cookie/dbMode gets essentials", () => {
    expect(resolveInitialNavMode({ ...base, cookie: null, dbMode: null, hasPrefsRow: false })).toBe(
      "essentials",
    );
  });

  it("an existing user with a preferences row keeps all (no unannounced change)", () => {
    expect(resolveInitialNavMode({ ...base, cookie: null, dbMode: null, hasPrefsRow: true })).toBe(
      "all",
    );
  });

  it("the demo identity (no row) gets essentials", () => {
    expect(
      resolveInitialNavMode({ ...base, cookie: null, dbMode: null, hasPrefsRow: false, isDemo: true }),
    ).toBe("essentials");
  });

  it("ignores a malformed dbMode and falls through to hasPrefsRow", () => {
    expect(
      resolveInitialNavMode({
        ...base,
        cookie: null,
        dbMode: "bogus" as unknown as NavMode,
        hasPrefsRow: true,
      }),
    ).toBe("all");
  });
});
