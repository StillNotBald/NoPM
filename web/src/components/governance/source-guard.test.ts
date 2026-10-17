/**
 * Source-inspection guards for the governance console (same pattern as
 * components/integrations/source-guard.test.ts: vitest runs in node with no
 * DOM, so these pin contracts that are visible in the source text).
 *
 * Each rule is a defect the UI audit found and a fix must not regress:
 *  - status-hue text on a tint/white must use the `-ink` tokens (light-mode AA);
 *  - four-eyes is decided by PERSON on the server, never by comparing actor ids in the page;
 *  - the client keeps the API's error `code` (so a refusal renders as what it is);
 *  - secrets shown once and destructive actions go through the shared panel / confirm dialog;
 *  - every <label> in the form-heavy pages is wired to a control.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const GOVERNANCE_DIRS = [
  "app/(console)/review",
  "app/(console)/change-control",
  "app/(console)/baselines",
  "app/(console)/decisions",
  "app/(console)/approvals",
  "app/(console)/trust",
  "app/(console)/tokens",
  "app/(console)/settings",
  "app/(console)/integrations",
  "components/review",
  "components/change-control",
  "components/approvals",
  "components/baselines",
  "components/decisions",
  "components/governance",
  "components/integrations",
];

const FILES = GOVERNANCE_DIRS.flatMap((d) => walk(join(SRC, d))).map((full) => ({
  name: relative(SRC, full).replace(/\\/g, "/"),
  text: readFileSync(full, "utf8"),
}));

const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("governance console source", () => {
  it("found the files it is meant to guard", () => {
    expect(FILES.length).toBeGreaterThan(40);
  });

  it("uses the -ink status tokens for text (no bare text-warning / success / danger / sev-high / change / info)", () => {
    const bare = /\b(?:hover:|focus:|group-hover:)?text-(?:warning|success|danger|sev-high|change|info)(?![\w-])/;
    for (const { name, text } of FILES) {
      expect(text, `${name}: bare status-hue text`).not.toMatch(bare);
    }
  });

  it("never sets brand-blue text on a brand-blue tint (3.98:1 in light mode)", () => {
    const onTint = /bg-accent\/\d+[^"'`\n]*\btext-accent(?![\w-])|\btext-accent(?![\w-])[^"'`\n]*bg-accent\/\d+/;
    for (const { name, text } of FILES) {
      expect(text, `${name}: text-accent on bg-accent/NN`).not.toMatch(onTint);
    }
  });

  it("does not use the solid accent pill as an audit/category colour", () => {
    for (const { name, text } of FILES) {
      expect(text, `${name}: <Badge tone="accent">`).not.toMatch(/tone=["']accent["']/);
    }
  });

  it("uses the text-2xs token, not an arbitrary 11px size", () => {
    for (const { name, text } of FILES) {
      expect(text, `${name}: text-[11px]`).not.toMatch(/text-\[11px\]/);
    }
  });
});

describe("four-eyes is decided by person, on the server", () => {
  it("the approvals page asks judgeDecision, not 'is the requester id my id'", () => {
    const page = read("app/(console)/approvals/page.tsx");
    expect(page).toContain("judgeDecision");
    expect(page).not.toMatch(/requested_by_id\s*===\s*user\.id/);
    expect(page).not.toContain("isOwn");
  });

  it("the change-control page asks judgeDecision and no longer counts requested_by !== user.id", () => {
    const page = read("app/(console)/change-control/page.tsx");
    expect(page).toContain("judgeDecision");
    expect(page).not.toMatch(/requested_by\s*!==\s*user\.id/);
  });

  it("the review gatherer computes a verdict for every decision kind", () => {
    const gather = read("lib/review/gather.ts");
    expect(gather.match(/judgeDecision\(/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("the shared note, not a private banner, states the rule in the inspectors and on /approvals", () => {
    for (const rel of ["components/review/inline-action.tsx", "app/(console)/approvals/page.tsx", "app/(console)/tokens/page.tsx"]) {
      expect(read(rel), rel).toContain("FourEyesNote");
    }
    expect(read("components/review/inline-action.tsx")).not.toMatch(/blocked at the API layer/);
    expect(read("app/(console)/approvals/page.tsx")).not.toMatch(/API layer|returns\{" "\}/);
  });

  it("the API client keeps the error code", () => {
    const client = read("lib/api-client.ts");
    expect(client).toMatch(/code\?: string/);
    expect(client).toMatch(/err\.code\s*=/);
  });
});

describe("secrets shown once, destructive actions confirmed", () => {
  it("/tokens reveals a new token in the shared ShowOncePanel and confirms a revoke in a dialog", () => {
    const tokens = read("app/(console)/tokens/page.tsx");
    expect(tokens).toContain("ShowOncePanel");
    expect(tokens).toContain("ConfirmDialog");
    // a revoke is not a bare DELETE inside a click handler any more
    expect(tokens).not.toMatch(/onClick=\{\(\) => handleRevoke/);
    expect(tokens).not.toMatch(/\bfetch\(/);
  });

  it("calendar-feed creation and 2FA backup codes use the same panel", () => {
    expect(read("components/integrations/calendar-feeds-card.tsx")).toContain("ShowOncePanel");
    expect(read("app/(console)/settings/page.tsx")).toContain("ShowOncePanel");
  });

  it("Disable 2FA asks first", () => {
    const settings = read("app/(console)/settings/page.tsx");
    expect(settings).toContain("ConfirmDialog");
    expect(settings).not.toMatch(/onClick=\{handleDisable\}/);
    expect(settings).not.toMatch(/\bfetch\(/);
  });
});

describe("labelled controls", () => {
  it("every <label> on /tokens, /settings, /trust is wired with htmlFor", () => {
    for (const rel of [
      "app/(console)/tokens/page.tsx",
      "app/(console)/settings/page.tsx",
      "app/(console)/trust/page.tsx",
    ]) {
      // A <label> that wraps its checkbox/radio is fine; a bare caption <label> over a control is not.
      const labels = read(rel).match(/<label\b[^>]*>/g) ?? [];
      for (const tag of labels) {
        const wraps = /className="[^"]*(?:flex|cursor-pointer)/.test(tag);
        expect(/htmlFor=/.test(tag) || wraps, `${rel}: ${tag}`).toBe(true);
      }
    }
  });
});
