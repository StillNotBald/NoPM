"use client";

import Link from "next/link";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The one focusable mark every timeline renderer uses (Gantt task bars,
 * roadmap project spans, milestone diamonds, Mainline nodes).
 *
 * - `label` is the full accessible name ("Task X, 3 Mar 2026 to 14 Mar 2026,
 *   critical path, slipped 4 days"); build it with `describeBar`.
 * - `href` -> a real link; `onActivate` -> a button that fires on Enter and
 *   Space exactly as a click does; neither -> a labelled image. It is NOT a tab
 *   stop: a mark with no action is not interactive, and 20+ of them made
 *   keyboard users tab through every bar. Screen readers still hear each one
 *   (aria-label) and get the same rows from the paired <TimelineTable>.
 * - `pattern` conveys status without colour: solid (done), none (in
 *   progress), dashed (not started), striped (canceled).
 * - Position/size come in via `style`; the visible focus ring is the shared
 *   `focus-ring` utility.
 */
export type TimelineBarPattern = "solid" | "plain" | "dashed" | "striped";

interface TimelineBarProps {
  label: string;
  style?: CSSProperties;
  className?: string;
  href?: string;
  onActivate?: () => void;
  pattern?: TimelineBarPattern;
  children?: ReactNode;
}

const STRIPES =
  "repeating-linear-gradient(135deg, transparent 0 4px, color-mix(in srgb, var(--color-ink-muted) 45%, transparent) 4px 6px)";

export function patternProps(pattern: TimelineBarPattern | undefined): {
  className: string;
  style?: CSSProperties;
} {
  switch (pattern) {
    case "dashed":
      return { className: "border border-dashed border-ink-muted" };
    case "striped":
      return { className: "", style: { backgroundImage: STRIPES } };
    default:
      return { className: "" };
  }
}

export function TimelineBar({
  label,
  style,
  className,
  href,
  onActivate,
  pattern,
  children,
}: TimelineBarProps) {
  const p = patternProps(pattern);
  const cls = cn(
    "focus-ring cursor-default",
    (href || onActivate) && "cursor-pointer",
    p.className,
    className,
  );
  const st: CSSProperties = { ...p.style, ...style };

  if (href) {
    return (
      <Link href={href} aria-label={label} title={label} className={cls} style={st}>
        {children}
      </Link>
    );
  }
  if (onActivate) {
    return (
      <div
        role="button"
        tabIndex={0}
        aria-label={label}
        title={label}
        className={cls}
        style={st}
        onClick={(e) => {
          e.stopPropagation();
          onActivate();
        }}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            onActivate();
          }
        }}
      >
        {children}
      </div>
    );
  }
  return (
    <div role="img" aria-label={label} title={label} className={cls} style={st}>
      {children}
    </div>
  );
}
