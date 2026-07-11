/**
 * Guard tests for wave3-mobile / W3-T3-landing-heatmap.
 *
 * Source-inspection pattern (see src/components/layout/mobile-chrome.test.ts)
 * rather than mounting React — no jsdom/@testing-library in this project
 * (vitest.config.ts runs `environment: "node"` and only globs
 * `src/**\/*.test.ts`, not .tsx). These tests pin the exact Tailwind class
 * tokens so a future edit can't silently drop a breakpoint gate and regress
 * desktop (locked decision: "desktop regression = failure").
 *
 * Covers:
 *   1. Landing nav collapses to brand + Case study + demo button below sm;
 *      Agent API / OpenAPI stay reachable (case-study page, footer) but are
 *      hidden below sm and restored unchanged at sm+.
 *   2. Landing hero h1 steps down text-4xl -> sm:text-5xl (no more
 *      undownscaled text-5xl).
 *   3. Case-study header's Home link is hidden below sm (tight fit at
 *      390px alongside Sign in + the demo button), restored at sm+; Sign in
 *      and the demo button stay visible at every width.
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
// 1. Landing nav — collapse below sm
// ---------------------------------------------------------------------------
describe("landing page.tsx — header nav collapses below sm", () => {
  const navBlock = LANDING.slice(LANDING.indexOf("<nav "), LANDING.indexOf("</nav>"));

  it("keeps Case study reachable at every width (no hidden gate)", () => {
    const caseStudyLine = navBlock
      .split("\n")
      .find((l) => l.includes('href="/case-study"'));
    expect(caseStudyLine).toBeTruthy();
    expect(caseStudyLine).not.toMatch(/hidden/);
  });

  it("hides Agent API below sm, restores it sm+ (still reachable via case-study/footer)", () => {
    const agentApiLine = navBlock.split("\n").find((l) => l.includes('href="/llms.txt"'));
    expect(agentApiLine).toBeTruthy();
    expect(agentApiLine).toMatch(/hidden sm:inline-flex/);
  });

  it("hides OpenAPI below sm, restores it sm+", () => {
    const openApiLine = navBlock
      .split("\n")
      .find((l) => l.includes('href="/api/openapi.json"'));
    expect(openApiLine).toBeTruthy();
    expect(openApiLine).toMatch(/hidden sm:inline-flex/);
  });

  it("keeps the demo/console button visible at every width (no hidden gate)", () => {
    const consoleBlock = navBlock.slice(navBlock.indexOf('href="/login"'));
    expect(consoleBlock).toMatch(/Open console/);
    const consoleLine = navBlock.split("\n").find((l) => l.includes('href="/login"'));
    expect(consoleLine).not.toMatch(/hidden/);
  });

  it("adds no new client JS / hamburger — nav stays pure CSS visibility", () => {
    expect(LANDING).not.toMatch(/"use client"/);
    expect(LANDING).not.toMatch(/hamburger/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Landing hero heading — mobile step
// ---------------------------------------------------------------------------
describe("landing page.tsx — hero h1 steps down on mobile", () => {
  it("h1 is text-4xl below sm, text-5xl at sm+ (no undownscaled text-5xl)", () => {
    const h1Line = LANDING.split("\n").find((l) => l.includes("<h1 "));
    expect(h1Line).toBeTruthy();
    expect(h1Line).toMatch(/text-4xl sm:text-5xl/);
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
// 3. Case-study header — Home hidden below sm (tight at 390px)
// ---------------------------------------------------------------------------
describe("case-study page.tsx — header fits 390px", () => {
  const navBlock = CASE_STUDY.slice(
    CASE_STUDY.indexOf("{/* ── nav ── */}"),
    CASE_STUDY.indexOf("{/* ── hero ── */}"),
  );

  it("hides the Home link below sm, restores it sm+", () => {
    const homeLine = navBlock.split("\n").find((l) => l.includes(">Home<"));
    expect(homeLine).toBeTruthy();
    expect(homeLine).toMatch(/hidden sm:inline\b/);
  });

  it("keeps Sign in and the demo button visible at every width", () => {
    const signInLine = navBlock.split("\n").find((l) => l.includes(">Sign in<"));
    expect(signInLine).toBeTruthy();
    expect(signInLine).not.toMatch(/hidden/);
    expect(navBlock).toMatch(/<DemoLoginButton/);
    const demoLine = navBlock.split("\n").find((l) => l.includes("<DemoLoginButton"));
    expect(demoLine).not.toMatch(/hidden/);
  });

  it("the brand logo/home link (icon) is unaffected — only the text nav link is gated", () => {
    const brandBlock = navBlock.slice(0, navBlock.indexOf("<nav "));
    expect(brandBlock).toMatch(/href="\/"/);
    expect(brandBlock).not.toMatch(/hidden/);
  });
});

// ---------------------------------------------------------------------------
// 4. Case-study hero heading — mobile step
// ---------------------------------------------------------------------------
describe("case-study page.tsx — hero h1 steps down on mobile", () => {
  it("h1 is text-3xl below sm, text-4xl at sm+ (no undownscaled text-4xl)", () => {
    const h1Line = CASE_STUDY.split("\n").find((l) => l.includes("<h1 "));
    expect(h1Line).toBeTruthy();
    expect(h1Line).toMatch(/text-3xl sm:text-4xl/);
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
