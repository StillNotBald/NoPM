import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Tone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";
type Size = "sm" | "md";

// semantic pills: 15% tint + ink token (darker than the fill hue so the text
// clears 4.5:1 on its own tint; see --*-ink in globals.css)
const tones: Record<Tone, string> = {
  neutral: "bg-sunken text-ink-secondary",
  accent: "bg-accent text-accent-ink",
  info: "bg-info/15 text-info-ink",
  success: "bg-success/15 text-success-ink",
  warning: "bg-warning/15 text-warning-ink",
  danger: "bg-danger/15 text-danger-ink",
};

// sm = tight inline use in dense rows; md = default standalone pill
const sizes: Record<Size, string> = {
  sm: "px-1.5 py-0.5 text-2xs",
  md: "px-2 py-0.5 text-xs",
};

export function Badge({
  tone = "neutral",
  size = "md",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; size?: Size }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full font-mono font-medium tracking-tight",
        sizes[size],
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
