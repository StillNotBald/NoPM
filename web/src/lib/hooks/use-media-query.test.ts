/**
 * use-media-query.ts is a DOM hook (matchMedia + useEffect) and this repo has
 * no jsdom dependency (vitest.config.ts runs `environment: "node"`, and the
 * project's "no new dependencies without asking" rule rules out adding one
 * just for this). So `useMediaQuery` itself isn't exercised here — instead
 * this tests the pure, DOM-free parts: the breakpoint query strings (data,
 * not behavior) and a source-scan pinning the hook's SSR-safe shape (initial
 * state = `defaultValue`, `matchMedia` read deferred to an effect) so a
 * future edit can't silently reintroduce a hydration-mismatch bug.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  QUERY_BELOW_SM,
  QUERY_BELOW_MD,
  QUERY_BELOW_LG,
  QUERY_MD_TO_LG,
  QUERY_MD_UP,
  QUERY_LG_UP,
} from "./use-media-query";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "hooks", "use-media-query.ts"), "utf8");

describe("breakpoint query constants — pure data, matches this codebase's Tailwind defaults", () => {
  it("below/at-or-above pairs are exact complements at their shared boundary", () => {
    expect(QUERY_BELOW_SM).toBe("(max-width: 639.98px)");
    expect(QUERY_BELOW_MD).toBe("(max-width: 767.98px)");
    expect(QUERY_MD_UP).toBe("(min-width: 768px)");
    expect(QUERY_BELOW_LG).toBe("(max-width: 1023.98px)");
    expect(QUERY_LG_UP).toBe("(min-width: 1024px)");
  });

  it("the md-to-lg tablet band sits exactly between md and lg with no gap or overlap", () => {
    expect(QUERY_MD_TO_LG).toBe("(min-width: 768px) and (max-width: 1023.98px)");
  });
});

describe("useMediaQuery — SSR-safe shape (source-scan; see file header for why)", () => {
  it("initial state is exactly `defaultValue` — no window/matchMedia read outside an effect", () => {
    const body = SOURCE.slice(SOURCE.indexOf("export function useMediaQuery"));
    expect(body).toMatch(/useState\(defaultValue\)/);
    // matchMedia must only be called inside useEffect, never at the top of
    // the function body (which would run identically during SSR and throw
    // there, or during the render itself and desync from the server markup)
    const beforeEffect = body.slice(0, body.indexOf("useEffect"));
    expect(beforeEffect).not.toMatch(/matchMedia/);
  });

  it("defaults the `defaultValue` param to false (mobile-only UI stays hidden until proven otherwise)", () => {
    expect(SOURCE).toMatch(/defaultValue = false/);
  });
});
