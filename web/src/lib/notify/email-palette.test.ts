/**
 * The notification email must wear the product's CURRENT palette.
 *
 * Mail clients drop CSS variables, so email.ts writes literal hex. That is how
 * it kept the pre-retheme cream/coral after the 2026-08-13 Fluent-blue retheme
 * (white-on-coral CTA at 3.12:1, a 75%-white label on coral at 2.41:1). These
 * tests tie every literal to its globals.css token and check the contrast of
 * each text/background pair, so a retheme or a one-off hex fails here instead
 * of shipping a different brand.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EMAIL_PALETTE, renderNotificationEmail } from "./email";

const CSS = readFileSync(join(process.cwd(), "src", "app", "globals.css"), "utf8");
// The light theme is the first :root block (the .dark block follows it).
const LIGHT_ROOT = CSS.slice(CSS.indexOf(":root {"), CSS.indexOf(".dark {"));

function token(name: string): string {
  const m = LIGHT_ROOT.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --${name} not found in the light :root block`);
  return m[1].toUpperCase();
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const sample = renderNotificationEmail({
  type: "approval.requested",
  title: "Deletion approval needed",
  body: "Requested by a teammate.",
});

describe("email palette mirrors the globals.css light tokens", () => {
  const pairs: Array<[keyof typeof EMAIL_PALETTE, string]> = [
    ["backdrop", "bg-sunken"],
    ["surface", "bg-surface"],
    ["border", "border-subtle"],
    ["ink", "text-primary"],
    ["inkSecondary", "text-secondary"],
    ["inkMuted", "text-muted"],
    ["accent", "accent"],
    ["accentInk", "accent-ink"],
    ["terminal", "terminal-surface"],
    ["terminalMuted", "terminal-text-muted"],
    ["dotRed", "terminal-red"],
    ["dotAmber", "terminal-amber"],
    ["dotGreen", "terminal-green"],
  ];

  it.each(pairs)("%s = --%s", (role, cssToken) => {
    expect(EMAIL_PALETTE[role].toUpperCase()).toBe(token(cssToken));
  });
});

describe("email palette contrast (WCAG AA, 4.5:1 for text)", () => {
  const P = EMAIL_PALETTE;
  const textOnBackground: Array<[string, string, string]> = [
    ["CTA label on the accent fill", P.accentInk, P.accent],
    ["title on the card", P.ink, P.surface],
    ["body copy on the card", P.inkSecondary, P.surface],
    ["footer text on the card", P.inkMuted, P.surface],
    ["wordmark on the terminal bar", P.terminalInk, P.terminal],
    ["type label on the terminal bar", P.terminalMuted, P.terminal],
  ];

  it.each(textOnBackground)("%s", (_label, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("rendered email uses only palette colours, inline", () => {
  const allowed = new Set(Object.values(EMAIL_PALETTE).map((h) => h.toUpperCase()));

  it("every hex colour in the HTML is a palette value", () => {
    const found = sample.html.match(/#[0-9a-fA-F]{6}\b/g) ?? [];
    expect(found.length).toBeGreaterThan(10);
    for (const hex of found) expect(allowed.has(hex.toUpperCase())).toBe(true);
  });

  it("carries none of the retired cream/coral brand", () => {
    expect(sample.html).not.toMatch(/FAF9F5|D97757|1C1B18|6B6860|E8E6DF/i);
  });

  it("no translucent white label on a coloured bar (it measured 2.41:1)", () => {
    expect(sample.html).not.toMatch(/rgba\(/);
  });

  it("is mail-safe: inline styles only, no CSS variables, <style>, media queries or SVG", () => {
    expect(sample.html).not.toMatch(/var\(--/);
    expect(sample.html).not.toMatch(/<style\b/i);
    expect(sample.html).not.toMatch(/@media/);
    expect(sample.html).not.toMatch(/<svg\b/i);
  });

  it("the CTA is the accent fill with the accent ink label", () => {
    expect(sample.html).toContain(`background-color:${EMAIL_PALETTE.accent};`);
    expect(sample.html).toMatch(
      new RegExp(`color:${EMAIL_PALETTE.accentInk};text-decoration:none[^>]*>View in NoPM`),
    );
  });

  it("the header bar is the terminal window with its three traffic lights", () => {
    expect(sample.html).toContain(`background-color:${EMAIL_PALETTE.terminal};`);
    for (const dot of [EMAIL_PALETTE.dotRed, EMAIL_PALETTE.dotAmber, EMAIL_PALETTE.dotGreen]) {
      expect(sample.html).toContain(`background-color:${dot};`);
    }
  });
});
