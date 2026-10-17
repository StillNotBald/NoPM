import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LANDING_DESCRIPTION, LANDING_TITLE } from "@/components/marketing/page-metadata";

/**
 * Guard tests for the marketing/entry surface's error handling + metadata,
 * following the source-inspection pattern used elsewhere in this repo
 * (see workspace-isolation.test.ts) rather than mounting React — there is
 * no jsdom/@testing-library dependency in this project.
 */

const APP_DIR = join(process.cwd(), "src", "app");
const ROOT_ERROR = readFileSync(join(APP_DIR, "error.tsx"), "utf8");
const CONSOLE_ERROR = readFileSync(join(APP_DIR, "(console)", "error.tsx"), "utf8");
const NOT_FOUND = readFileSync(join(APP_DIR, "not-found.tsx"), "utf8");
const LAYOUT = readFileSync(join(APP_DIR, "layout.tsx"), "utf8");
const GLOBAL_ERROR = readFileSync(join(APP_DIR, "global-error.tsx"), "utf8");
const PAGE_METADATA = readFileSync(
  join(process.cwd(), "src", "components", "marketing", "page-metadata.ts"),
  "utf8",
);
const ENV_EXAMPLE = readFileSync(join(process.cwd(), ".env.example"), "utf8");

describe("root error boundary (src/app/error.tsx)", () => {
  it("is a client component", () => {
    expect(ROOT_ERROR.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("implements the Next.js error-boundary contract (error + retry props, reset as fallback)", () => {
    expect(ROOT_ERROR).toMatch(/error:\s*Error/);
    // retry() re-fetches and re-renders; reset() alone re-renders the same
    // failed payload, which made "Try again" a no-op for a transient error.
    expect(ROOT_ERROR).toMatch(/retry\??:\s*\(\)\s*=>\s*void/);
    expect(ROOT_ERROR).toMatch(/reset\??:\s*\(\)\s*=>\s*void/);
    expect(ROOT_ERROR).toMatch(/retry \?\? reset/);
  });

  it("is a page of its own: one <main> landmark and one <h1>, not a bare <h2>", () => {
    expect(ROOT_ERROR).toMatch(/<main\b/);
    expect(ROOT_ERROR).toMatch(/<h1\b/);
    expect(ROOT_ERROR).not.toMatch(/<h2\b/);
  });

  it("recovers to the landing page, not the console dashboard", () => {
    expect(ROOT_ERROR).toMatch(/window\.location\.href\s*=\s*"\/"/);
    expect(ROOT_ERROR).not.toMatch(/\/dashboard/);
  });

  it("offers the zero-JS demo entry via POST /api/auth/demo-login", () => {
    expect(ROOT_ERROR).toMatch(/method="POST"/);
    expect(ROOT_ERROR).toMatch(/action="\/api\/auth\/demo-login"/);
  });

  it("never exposes the raw error message or stack, only an optional digest", () => {
    expect(ROOT_ERROR).not.toMatch(/error\.message/);
    expect(ROOT_ERROR).not.toMatch(/error\.stack/);
    expect(ROOT_ERROR).toMatch(/error\.digest/);
  });

  it("mirrors the console error boundary's structure/tone (shared classes)", () => {
    for (const cls of [
      "border-border-subtle",
      "bg-surface",
      "text-danger",
      "text-ink",
      "text-ink-secondary",
      "text-ink-muted",
    ]) {
      expect(CONSOLE_ERROR).toContain(cls);
      expect(ROOT_ERROR).toContain(cls);
    }
  });
});

describe("root not-found page (src/app/not-found.tsx)", () => {
  it("is a page of its own: <main>, an <h1>, a title, and the wordmark for site context", () => {
    expect(NOT_FOUND).toMatch(/<main\b/);
    expect(NOT_FOUND).toMatch(/<h1\b/);
    expect(NOT_FOUND).not.toMatch(/<h2\b/);
    expect(NOT_FOUND).toMatch(/title:\s*"Page not found"/);
    expect(NOT_FOUND).toMatch(/<Wordmark/);
  });

  it("is flat: DESIGN.md reserves shadows for floating layers, not resting cards", () => {
    expect(NOT_FOUND).not.toMatch(/shadow-(sm|md|lg)/);
    expect(ROOT_ERROR).not.toMatch(/shadow-(sm|md|lg)/);
  });

  it("links back to the landing page and the case study", () => {
    expect(NOT_FOUND).toMatch(/href="\/"/);
    expect(NOT_FOUND).toMatch(/href="\/case-study"/);
  });

  it("does not link into the console", () => {
    expect(NOT_FOUND).not.toMatch(/\/dashboard/);
  });

  it("uses the shared theme tokens (no cream/coral introduced)", () => {
    expect(NOT_FOUND).toContain("border-border-subtle");
    expect(NOT_FOUND).toContain("bg-surface");
    expect(NOT_FOUND).not.toMatch(/#FAF9F5|#D97757/i);
  });
});

describe("global error boundary (src/app/global-error.tsx)", () => {
  it("is a client component that brings its own <html>, <body>, <main> and <h1>", () => {
    expect(GLOBAL_ERROR.trimStart().startsWith('"use client"')).toBe(true);
    expect(GLOBAL_ERROR).toMatch(/<html\b/);
    expect(GLOBAL_ERROR).toMatch(/<body\b/);
    expect(GLOBAL_ERROR).toMatch(/<main\b/);
    expect(GLOBAL_ERROR).toMatch(/<h1\b/);
  });

  it("imports the global CSS itself (it replaces the root layout that normally does)", () => {
    expect(GLOBAL_ERROR).toMatch(/import "\.\/globals\.css"/);
  });

  it("never exposes the raw error message or stack, only an optional digest", () => {
    expect(GLOBAL_ERROR).not.toMatch(/error\.message/);
    expect(GLOBAL_ERROR).not.toMatch(/error\.stack/);
    expect(GLOBAL_ERROR).toMatch(/error\.digest/);
  });
});

describe("layout metadata (src/app/layout.tsx + marketing/page-metadata.ts)", () => {
  it("declares OpenGraph metadata with the governance-grade positioning", () => {
    expect(LAYOUT).toMatch(/openGraph:/);
    expect(LAYOUT).toMatch(/siteName:\s*SITE_NAME/);
    expect(PAGE_METADATA).toMatch(/SITE_NAME\s*=\s*"NoPM"/);
    expect(PAGE_METADATA).toMatch(/SITE_URL\s*=\s*"https:\/\/stillnotbald\.com"/);
  });

  it("resolves absolute URLs against metadataBase", () => {
    expect(LAYOUT).toMatch(/metadataBase:\s*new URL\(SITE_URL\)/);
  });

  it("declares a large-image Twitter card (there is an og:image now)", () => {
    expect(LAYOUT).toMatch(/twitter:/);
    expect(LAYOUT).toMatch(/card:\s*"summary_large_image"/);
  });

  it("draws the og:image from file-based opengraph-image routes, not a hand-written images: field", () => {
    expect(LAYOUT).not.toMatch(/images:/);
    expect(existsSync(join(APP_DIR, "opengraph-image.tsx"))).toBe(true);
    expect(existsSync(join(APP_DIR, "case-study", "opengraph-image.tsx"))).toBe(true);
  });

  it("uses the landing's one phrase for the root default title and description", () => {
    expect(LAYOUT).toMatch(/default:\s*LANDING_TITLE/);
    expect(LAYOUT).toMatch(/description:\s*LANDING_DESCRIPTION/);
    // "maker-checker" is the contributor term; public copy says four-eyes.
    expect(LAYOUT).not.toMatch(/maker-checker/i);
    expect(`${LANDING_TITLE} ${LANDING_DESCRIPTION}`).not.toMatch(/maker-checker/i);
  });
});

describe(".env.example documents required vars without values", () => {
  const REQUIRED_NAMES = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_APP_URL",
    "NOPM_TOKEN_PREFIX",
    "NOPM_ENCRYPTION_KEY",
    "DEMO_EMAIL",
    "DEMO_PASSWORD",
    "NOPM_DEMO_LLM_PROVIDER",
    "NOPM_DEMO_LLM_KEY",
    "NOPM_DEMO_LLM_MODEL",
  ];

  it.each(REQUIRED_NAMES)("documents %s", (name) => {
    expect(ENV_EXAMPLE).toMatch(new RegExp(`^${name}=`, "m"));
  });

  it("never commits a real-looking secret value (no long base64/hex literals)", () => {
    // Each declared var's value should be a placeholder in <angle-brackets>,
    // a literal default (npm_, openai, gpt-4o-mini, a localhost URL), or blank —
    // never a real 32-byte base64 key or similar secret material.
    const lines = ENV_EXAMPLE.split("\n").filter((l) => /^[A-Z_]+=/.test(l));
    for (const line of lines) {
      const value = line.split("#")[0].split("=")[1]?.trim() ?? "";
      const looksLikeRealSecret = /^[A-Za-z0-9+/]{32,}={0,2}$/.test(value);
      expect(looksLikeRealSecret).toBe(false);
    }
  });
});
