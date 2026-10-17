/**
 * Guard tests for wave3-mobile / W3-T3-landing-heatmap, updated for the
 * R-94 mobile pass (2026-09-07).
 *
 * Source-inspection pattern (see src/components/layout/mobile-chrome.test.ts)
 * rather than mounting React — no jsdom/@testing-library in this project
 * (vitest.config.ts runs `environment: "node"` and only globs
 * `src/**\/*.test.ts`, not .tsx). These tests pin the exact Tailwind class
 * tokens so a future edit can't silently drop a breakpoint gate and regress
 * desktop (locked decision: "desktop regression = failure").
 *
 * SUPERSEDES the original wave3 "nav stays pure CSS visibility, no
 * hamburger" lock: the R-94 mobile pass found the landing/case-study nav
 * had five reachable-but-hidden-below-sm links with no way to open them on
 * a phone (Agent API, OpenAPI, Raise a change request were unreachable
 * below 640px; Home/Sign in on case-study had the same gap below md). The
 * fix is a 44px hamburger (`MobileNavMenu`, `components/marketing/`)
 * built on the same body-scroll-lock/inert/focus-return hooks every other
 * sheet in the product uses — not a new pattern, just marketing catching up
 * to the console's own sheet convention. `<md` is "phone" per
 * `components/ui/MOBILE.md`; the breakpoint moved from `sm` (640) to `md`
 * (768) so nothing sits hidden-and-unreachable in the 640-767px gap.
 *
 * UF5 (public-page UI fix wave) SUPERSEDES two more locks: the landing's
 * accent "Open console" link (it delivered a sign-in form, not the console,
 * and was a second primary beside the hero's) is now the shared demo button,
 * and both pages' header demo button is hidden below `sm` — at 320px the
 * longer "Try the live demo" label no longer fits beside the brand and the
 * menu, and the hero's own button is the one primary in view on a phone.
 * Brand marks moved into the shared `Wordmark` (44px target, dark-mode safe).
 *
 * Covers:
 *   1. Landing nav collapses to brand + Open console + a menu button below
 *      md; Case study / Raise a change request / Agent API / OpenAPI move
 *      into the menu (reachable via MobileNavMenu) and restore inline,
 *      unchanged, at md+.
 *   2. Landing hero h1 scales via a mobile clamp below sm, steps to
 *      sm:text-5xl / xl:text-6xl unchanged above sm (no undownscaled
 *      text-5xl).
 *   3. Case-study header's Home and Sign in links move into the same
 *      MobileNavMenu below md (the demo button shows from sm up, per the
 *      UF5 note above), restored unchanged at md+.
 *   4. Case-study hero h1 steps down text-3xl -> sm:text-4xl (no more
 *      undownscaled text-4xl).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(process.cwd(), "src", "app");
const LANDING = readFileSync(join(APP_DIR, "page.tsx"), "utf8");
const CASE_STUDY = readFileSync(join(APP_DIR, "case-study", "page.tsx"), "utf8");

// ---------------------------------------------------------------------------
// 1. Landing nav — collapse below md, reachable via MobileNavMenu
// ---------------------------------------------------------------------------
describe("landing page.tsx — header nav collapses below md", () => {
  const navBlock = LANDING.slice(LANDING.indexOf("<nav "), LANDING.indexOf("</nav>"));

  it("hides Case study below md, restores it md+ (reachable via the menu below md)", () => {
    const caseStudyLine = navBlock
      .split("\n")
      .find((l) => l.includes('href="/case-study"') && l.includes("<Link"));
    expect(caseStudyLine).toBeTruthy();
    expect(caseStudyLine).toMatch(/hidden md:inline\b/);
  });

  it("hides Agent API below md, restores it md+ (reachable via the menu below md)", () => {
    const agentApiLine = navBlock
      .split("\n")
      .find((l) => l.includes('href="/llms.txt"') && l.includes("<a "));
    expect(agentApiLine).toBeTruthy();
    expect(agentApiLine).toMatch(/hidden md:inline-flex/);
  });

  it("hides OpenAPI below md, restores it md+ (reachable via the menu below md)", () => {
    const openApiLine = navBlock
      .split("\n")
      .find((l) => l.includes('href="/api/openapi.json"') && l.includes("<a "));
    expect(openApiLine).toBeTruthy();
    expect(openApiLine).toMatch(/hidden md:inline-flex/);
  });

  it("offers the demo from sm up as the shared DemoLoginButton (no more 'Open console' link to a sign-in form)", () => {
    expect(navBlock).not.toMatch(/Open console/);
    const idx = navBlock.indexOf("<DemoLoginButton");
    expect(idx).toBeGreaterThan(-1);
    // hidden below sm, shown from sm up — wrapped, so the button's own markup stays one definition
    expect(navBlock.slice(Math.max(0, idx - 120), idx)).toMatch(/hidden sm:block/);
  });

  it("keeps Sign in reachable at every width: inline from lg, in the menu below md, and as the hero's text link between", () => {
    const signInLine = navBlock
      .split("\n")
      .find((l) => l.includes('href="/login"') && l.includes("<Link"));
    expect(signInLine).toBeTruthy();
    // lg, not md: at 768-1023px the extra link plus the demo button overflow the header
    expect(signInLine).toMatch(/hidden lg:inline\b/);
    expect(LANDING).toMatch(/<ButtonLink href="\/login" variant="link"/);
    expect(navBlock.slice(navBlock.indexOf("<MobileNavMenu"))).toContain('label: "Sign in"');
  });

  it("renders MobileNavMenu, gated to below md, carrying every link hidden from the inline nav", () => {
    expect(navBlock).toMatch(/<MobileNavMenu/);
    const menuBlock = navBlock.slice(navBlock.indexOf("<MobileNavMenu"));
    expect(menuBlock).toMatch(/className="md:hidden"/);
    for (const href of ['"/case-study"', "CONTACT_URL", '"/llms.txt"', '"/api/openapi.json"', '"/login"']) {
      expect(menuBlock).toContain(href);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Landing hero heading — mobile step
// ---------------------------------------------------------------------------
describe("landing page.tsx — hero h1 steps down on mobile", () => {
  it("h1 clamps below sm, steps to sm:text-5xl / xl:text-6xl unchanged above sm", () => {
    const h1Line = LANDING.split("\n").find((l) => l.includes("<h1 "));
    expect(h1Line).toBeTruthy();
    expect(h1Line).toMatch(/text-\[clamp\([^)]+\)\] sm:text-5xl xl:text-6xl/);
  });

  it("has no bare (non-stepped) text-4xl/5xl/6xl heading anywhere on the page", () => {
    // Every className line carrying a >=text-4xl token must also carry a
    // matching sm: step on the same line (i.e. never appear stranded).
    for (const line of LANDING.split("\n")) {
      const has4xlPlus = /\btext-[456]xl\b/.test(line) && !/sm:text-[456]xl/.test(line);
      if (has4xlPlus) {
        expect(line).toMatch(/sm:text-[456]xl/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Case-study header — Home + Sign in move into the menu below md
// ---------------------------------------------------------------------------
describe("case-study page.tsx — header fits 390px", () => {
  const navBlock = CASE_STUDY.slice(CASE_STUDY.indexOf("<header"), CASE_STUDY.indexOf("</header>"));

  it("hides the Home link below md, restores it md+", () => {
    const homeLine = navBlock.split("\n").find((l) => l.includes(">Home<"));
    expect(homeLine).toBeTruthy();
    expect(homeLine).toMatch(/hidden md:inline\b/);
  });

  it("hides the Sign in link below md, restores it md+ (still reachable via the menu below md)", () => {
    const signInLine = navBlock.split("\n").find((l) => l.includes(">Sign in<"));
    expect(signInLine).toBeTruthy();
    expect(signInLine).toMatch(/hidden md:inline\b/);
  });

  it("shows the header demo button from sm up only (the hero's button is the one primary on a phone)", () => {
    const idx = navBlock.indexOf("<DemoLoginButton");
    expect(idx).toBeGreaterThan(-1);
    expect(navBlock.slice(Math.max(0, idx - 120), idx)).toMatch(/hidden sm:block/);
  });

  it("renders MobileNavMenu, gated to below md, carrying Home and Sign in", () => {
    expect(navBlock).toMatch(/<MobileNavMenu/);
    const menuBlock = navBlock.slice(navBlock.indexOf("<MobileNavMenu"));
    expect(menuBlock).toMatch(/className="md:hidden"/);
    expect(menuBlock).toContain('label: "Home"');
    expect(menuBlock).toContain('label: "Sign in"');
  });

  it("the brand logo/home link is the shared Wordmark — never gated by a breakpoint", () => {
    const brandBlock = navBlock.slice(0, navBlock.indexOf("<nav "));
    expect(brandBlock).toMatch(/<Wordmark/);
    expect(brandBlock).not.toMatch(/hidden/);
  });
});

// ---------------------------------------------------------------------------
// 4. Case-study hero heading — mobile step
// ---------------------------------------------------------------------------
describe("case-study page.tsx — hero h1 steps down on mobile", () => {
  it("h1 is text-3xl below sm, stepped up at sm+ (no undownscaled display size)", () => {
    const h1Line = CASE_STUDY.split("\n").find((l) => l.includes("<h1 "));
    expect(h1Line).toBeTruthy();
    expect(h1Line).toMatch(/text-3xl sm:text-[45]xl/);
  });

  it("has no bare (non-stepped) text-4xl/5xl/6xl heading anywhere on the page", () => {
    for (const line of CASE_STUDY.split("\n")) {
      const has4xlPlus = /\btext-[456]xl\b/.test(line) && !/sm:text-[456]xl/.test(line);
      if (has4xlPlus) {
        expect(line).toMatch(/sm:text-[456]xl/);
      }
    }
  });
});
