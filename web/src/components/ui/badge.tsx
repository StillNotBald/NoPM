import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Tone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";

// vibrant semantic pills (strong tint + saturated text)
const tones: Record<Tone, string> = {
  neutral: "bg-sunken text-ink-secondary",
  accent: "bg-accent text-accent-ink",
  info: "bg-info/15 text-info",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
};

export function Badge({
  tone = "neutral",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-xs font-medium tracking-tight",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
