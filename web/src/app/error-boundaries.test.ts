import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
const ENV_EXAMPLE = readFileSync(join(process.cwd(), ".env.example"), "utf8");

describe("root error boundary (src/app/error.tsx)", () => {
  it("is a client component", () => {
    expect(ROOT_ERROR.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("implements the Next.js error-boundary contract (error + reset props)", () => {
    expect(ROOT_ERROR).toMatch(/error:\s*Error/);
    expect(ROOT_ERROR).toMatch(/reset:\s*\(\)\s*=>\s*void/);
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

describe("layout metadata (src/app/layout.tsx)", () => {
  it("declares OpenGraph metadata with the governance-grade positioning", () => {
    expect(LAYOUT).toMatch(/openGraph:/);
    expect(LAYOUT).toMatch(/siteName:\s*"NoPM"/);
    expect(LAYOUT).toMatch(/https:\/\/stillnotbald\.com/);
  });

  it("declares a Twitter summary card", () => {
    expect(LAYOUT).toMatch(/twitter:/);
    expect(LAYOUT).toMatch(/card:\s*"summary"/);
  });

  it("does not invent an og:image asset (public/ has no NoPM-branded image)", () => {
    expect(LAYOUT).not.toMatch(/images:/);
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
