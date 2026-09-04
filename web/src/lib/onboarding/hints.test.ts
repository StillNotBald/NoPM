import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { PAGE_HINTS, hintFor, isHintDismissed, dismissHint, MAX_DISMISSED } from "./hints";

// vitest's cwd is web/ — repo root is one level up.
const REPO_ROOT = resolve(__dirname, "../../../..");

describe("PAGE_HINTS registry", () => {
  it("every id is unique", () => {
    const ids = PAGE_HINTS.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every text is non-empty and at most 120 chars", () => {
    for (const hint of PAGE_HINTS) {
      expect(hint.text.length).toBeGreaterThan(0);
      expect(hint.text.length).toBeLessThanOrEqual(120);
    }
  });

  it("every match starts with /", () => {
    for (const hint of PAGE_HINTS) {
      expect(hint.match.startsWith("/")).toBe(true);
    }
  });

  it("has no entry for /dashboard or /start", () => {
    for (const hint of PAGE_HINTS) {
      expect(hint.match).not.toBe("/dashboard");
      expect(hint.match).not.toBe("/start");
    }
  });

  it("every docHref, when set, points at a file that exists on disk", () => {
    const withDocs = PAGE_HINTS.filter((h) => h.docHref);
    expect(withDocs.length).toBeGreaterThan(0); // sanity — at least one entry exercises this
    for (const hint of withDocs) {
      const onDisk = resolve(REPO_ROOT, `.${hint.docHref}`);
      expect(existsSync(onDisk), `${hint.docHref} (id: ${hint.id})`).toBe(true);
    }
  });
});

describe("hintFor — longest-prefix / exact-vs-nested match", () => {
  it("returns null for /dashboard", () => {
    expect(hintFor("/dashboard")).toBeNull();
  });

  it("returns null for /start", () => {
    expect(hintFor("/start")).toBeNull();
  });

  it("returns null for null pathname", () => {
    expect(hintFor(null)).toBeNull();
  });

  it("returns null for an unknown page", () => {
    expect(hintFor("/some-unmapped-page")).toBeNull();
  });

  it("matches the bare index page by exact path", () => {
    expect(hintFor("/risks")?.id).toBe("risks");
  });

  it("/projects (bare index) resolves to the projects hint", () => {
    expect(hintFor("/projects")?.id).toBe("projects");
  });

  it("/projects/abc-123 (one project) resolves to project-detail", () => {
    expect(hintFor("/projects/abc-123")?.id).toBe("project-detail");
  });

  it("/projects/abc-123/board (a project sub-route) still resolves to project-detail", () => {
    expect(hintFor("/projects/abc-123/board")?.id).toBe("project-detail");
  });
});

describe("isHintDismissed", () => {
  it("false when config is undefined", () => {
    expect(isHintDismissed(undefined, "risks")).toBe(false);
  });

  it("false when hints.dismissed doesn't include the id", () => {
    expect(isHintDismissed({ hints: { dismissed: ["trust"] } }, "risks")).toBe(false);
  });

  it("true when hints.dismissed includes the id", () => {
    expect(isHintDismissed({ hints: { dismissed: ["risks", "trust"] } }, "risks")).toBe(true);
  });
});

describe("dismissHint", () => {
  it("adds a new id to an empty/undefined config", () => {
    expect(dismissHint(undefined, "risks")).toEqual({ hints: { dismissed: ["risks"] } });
  });

  it("appends without duplicating an existing id", () => {
    const config = { hints: { dismissed: ["risks"] } };
    expect(dismissHint(config, "risks")).toEqual({ hints: { dismissed: ["risks"] } });
  });

  it("preserves other dismissed ids alongside the new one", () => {
    const config = { hints: { dismissed: ["risks"] } };
    expect(dismissHint(config, "trust")).toEqual({ hints: { dismissed: ["risks", "trust"] } });
  });

  it("caps the dismissed array at MAX_DISMISSED, evicting oldest first", () => {
    const bloated = Array.from({ length: MAX_DISMISSED }, (_, i) => `hint-${i}`);
    const next = dismissHint({ hints: { dismissed: bloated } }, "new-hint");
    expect(next.hints?.dismissed).toHaveLength(MAX_DISMISSED);
    expect(next.hints?.dismissed).not.toContain("hint-0");
    expect(next.hints?.dismissed).toContain("new-hint");
  });
});
