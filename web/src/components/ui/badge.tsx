import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Tone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";
type Size = "sm" | "md";

// vibrant semantic pills (strong tint + saturated text)
const tones: Record<Tone, string> = {
  neutral: "bg-sunken text-ink-secondary",
  accent: "bg-accent text-accent-ink",
  info: "bg-info/15 text-info",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
};

// sm = tight inline use in dense rows; md = default standalone pill
const sizes: Record<Size, string> = {
  sm: "px-1.5 py-0.5 text-[11px]",
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
