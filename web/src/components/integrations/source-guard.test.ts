/**
 * Source-inspection guards for the Integrations console (same pattern as
 * `components/layout/mobile-chrome.test.ts`: vitest runs in a node
 * environment with no DOM, so these pin contracts that are visible in the
 * source text rather than mounting React).
 *
 *  - Tokens only: no raw hex colours, no hard-coded Tailwind palette classes,
 *    no `dark:` variants — dark mode must follow from the theme tokens alone.
 *  - Secrets: the page never persists (web storage) or logs (console) anything.
 *  - Hygiene: no absolute user-profile paths in tracked files.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS_DIR = join(process.cwd(), "src", "components", "integrations");
const PAGE_DIR = join(process.cwd(), "src", "app", "(console)", "integrations");

function sourceFiles(dir: string): { name: string; text: string }[] {
  return readdirSync(dir)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"))
    .map((f) => ({ name: f, text: readFileSync(join(dir, f), "utf8") }));
}

const FILES = [...sourceFiles(COMPONENTS_DIR), ...sourceFiles(PAGE_DIR)];

const PALETTE =
  /\b(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|accent)-(?:slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;

describe("integrations console source", () => {
  it("found the files it is meant to guard", () => {
    expect(FILES.length).toBeGreaterThanOrEqual(12);
    expect(FILES.map((f) => f.name)).toContain("page.tsx");
  });

  it("uses theme tokens only (no hex colours, palette classes or dark: variants)", () => {
    for (const { name, text } of FILES) {
      expect(text, `${name}: raw hex colour`).not.toMatch(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-zA-Z_-])/);
      expect(text, `${name}: hard-coded palette class`).not.toMatch(PALETTE);
      expect(text, `${name}: dark: variant`).not.toMatch(/\bdark:/);
    }
  });

  it("never persists or logs secrets", () => {
    for (const { name, text } of FILES) {
      expect(text, `${name}: web storage`).not.toMatch(/localStorage|sessionStorage|indexedDB/);
      expect(text, `${name}: console output`).not.toMatch(/\bconsole\.(log|info|debug|warn|error)\b/);
    }
  });

  it("carries no absolute user-profile paths", () => {
    for (const { name, text } of FILES) {
      expect(text, `${name}: absolute path`).not.toMatch(/[A-Za-z]:\\Users\\|\/Users\/|\/home\/[a-z]/);
    }
  });

  it("routes every network call through the shared API client", () => {
    for (const { name, text } of FILES) {
      expect(text, `${name}: raw fetch`).not.toMatch(/\bfetch\(/);
    }
  });
});
