import { extendTailwindMerge } from "tailwind-merge";

/**
 * Class joiner that RESOLVES conflicting Tailwind utilities (last one wins),
 * so `cn("text-ink-secondary", "text-danger-ink")` renders danger, not
 * whichever utility happens to come later in the generated stylesheet.
 *
 * tailwind-merge is configured for this project's tokens (globals.css
 * `@theme`): the custom text colours (`text-ink-secondary`, `text-danger-ink`
 * ...) are COLOURS and the `text-2xs` size is a FONT SIZE, so the two groups
 * never evict each other (`cn("text-2xs", "text-ink")` keeps both). The
 * custom `focus-ring` / `focus-ring-inset` / `field` utilities are not
 * Tailwind groups and pass through untouched.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["2xs"],
      color: [
        "canvas",
        "surface",
        "page",
        "well",
        "border-subtle",
        "border-strong",
        "ink",
        "ink-secondary",
        "ink-muted",
        "accent",
        "accent-hover",
        "accent-ink",
        "info",
        "success",
        "warning",
        "sev-high",
        "danger",
        "change",
        "info-ink",
        "success-ink",
        "warning-ink",
        "danger-ink",
        "sev-high-ink",
        "change-ink",
        "danger-hover",
        "danger-solid",
        "terminal-surface",
        "terminal-border",
        "terminal-text",
        "terminal-text-muted",
        "terminal-red",
        "terminal-amber",
        "terminal-green",
        "terminal-red-ink",
        "terminal-amber-ink",
        "terminal-green-ink",
      ],
    },
  },
});

export type ClassPart = string | false | null | undefined;

export function cn(...parts: ClassPart[]): string {
  return twMerge(parts.filter(Boolean).join(" "));
}
