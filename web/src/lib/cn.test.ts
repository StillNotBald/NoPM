/**
 * cn() resolves conflicting Tailwind utilities against THIS project's tokens.
 * The point of the suite: text SIZES and text COLOURS share the `text-` prefix
 * and must never evict each other, including the custom `text-2xs` size and
 * the custom `text-ink-*` / `text-*-ink` colours from globals.css.
 */
import { describe, expect, it } from "vitest";
import { cn } from "./cn";

const classes = (s: string) => s.split(/\s+/).filter(Boolean).sort();

describe("cn — colour conflicts resolve to the last utility", () => {
  it("a tone override beats the base text colour (the grey revoke-button bug)", () => {
    expect(cn("text-ink-secondary", "text-danger-ink")).toBe("text-danger-ink");
    expect(cn("text-ink-secondary hover:bg-well", "text-danger-ink hover:bg-danger/10")).toBe(
      "text-danger-ink hover:bg-danger/10",
    );
  });

  it("every custom text colour token conflicts with every other", () => {
    for (const a of ["ink", "ink-secondary", "ink-muted", "accent", "accent-ink", "danger-ink", "warning-ink", "sev-high-ink", "change-ink"]) {
      for (const b of ["ink", "ink-secondary", "ink-muted", "accent", "accent-ink", "danger-ink", "warning-ink", "sev-high-ink", "change-ink"]) {
        expect(cn(`text-${a}`, `text-${b}`)).toBe(`text-${b}`);
      }
    }
  });

  it("fills, borders and rings resolve independently per property", () => {
    expect(cn("bg-accent text-accent-ink", "bg-danger-solid text-white")).toBe("bg-danger-solid text-white");
    expect(cn("border-border-subtle", "border-accent")).toBe("border-accent");
    expect(cn("border-l-2 border-transparent", "border-accent")).toBe("border-l-2 border-accent");
    expect(cn("ring-2 ring-accent", "ring-danger")).toBe("ring-2 ring-danger");
  });

  it("modifier variants are tracked separately", () => {
    expect(cn("hover:bg-well", "hover:bg-accent-hover")).toBe("hover:bg-accent-hover");
    expect(classes(cn("bg-accent hover:bg-accent-hover", "dark:bg-well"))).toEqual(
      classes("bg-accent hover:bg-accent-hover dark:bg-well"),
    );
  });
});

describe("cn — sizes and colours are not confused", () => {
  it("keeps a text size next to a text colour, in either order", () => {
    expect(classes(cn("text-sm", "text-ink"))).toEqual(["text-ink", "text-sm"]);
    expect(classes(cn("text-ink", "text-sm"))).toEqual(["text-ink", "text-sm"]);
    expect(classes(cn("text-xs text-ink-muted", "text-danger-ink"))).toEqual(["text-danger-ink", "text-xs"]);
  });

  it("treats the custom text-2xs as a SIZE, not a colour", () => {
    expect(classes(cn("text-2xs", "text-ink-muted"))).toEqual(["text-2xs", "text-ink-muted"]);
    expect(classes(cn("text-ink-muted", "text-2xs"))).toEqual(["text-2xs", "text-ink-muted"]);
    expect(classes(cn("text-2xs", "text-accent-ink"))).toEqual(["text-2xs", "text-accent-ink"]);
  });

  it("sizes still replace sizes (including text-2xs) and arbitrary lengths are sizes", () => {
    expect(cn("text-2xs", "text-sm")).toBe("text-sm");
    expect(cn("text-sm", "text-2xs")).toBe("text-2xs");
    expect(cn("text-xs", "text-base")).toBe("text-base");
    expect(classes(cn("text-ink", "text-[13px]"))).toEqual(["text-[13px]", "text-ink"]);
    expect(cn("text-[13px]", "text-sm")).toBe("text-sm");
  });

  it("does not confuse font weight, family and size", () => {
    expect(classes(cn("font-mono text-xs", "font-semibold"))).toEqual(["font-mono", "font-semibold", "text-xs"]);
    expect(cn("font-medium", "font-semibold")).toBe("font-semibold");
    expect(cn("font-sans", "font-mono")).toBe("font-mono");
  });

  it("does not confuse border width with border colour, or shadow size with shadow colour", () => {
    expect(classes(cn("border border-border-subtle", "border-2"))).toEqual(["border-2", "border-border-subtle"]);
    expect(classes(cn("shadow-md", "shadow-black/10"))).toEqual(["shadow-black/10", "shadow-md"]);
    expect(cn("shadow-md", "shadow-lg")).toBe("shadow-lg");
  });
});

describe("cn — responsive overrides (the Input / Button height contract)", () => {
  it("a caller's sm: height replaces the primitive's sm: height but keeps the phone floor", () => {
    expect(cn("h-11 sm:h-10", "sm:h-9")).toBe("h-11 sm:h-9");
    expect(cn("h-11 sm:h-8", "h-11 sm:h-10")).toBe("h-11 sm:h-10");
    expect(cn("px-3", "px-5")).toBe("px-5");
  });
});

describe("cn — passthrough", () => {
  it("drops falsy parts", () => {
    expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
    expect(cn()).toBe("");
  });

  it("never touches the project's custom utilities", () => {
    expect(classes(cn("focus-ring field", "focus-ring-inset"))).toEqual(["field", "focus-ring", "focus-ring-inset"]);
    expect(cn("motion-reduce:animate-none animate-pulse")).toBe("motion-reduce:animate-none animate-pulse");
  });
});
