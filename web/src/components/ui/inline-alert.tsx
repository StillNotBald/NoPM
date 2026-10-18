import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "danger" | "warning" | "success" | "neutral";

/**
 * Inline message block for form errors, save confirmations and notices.
 * `danger` is announced assertively (`role="alert"`); every other tone
 * politely (`role="status"`). Text uses the `-ink` tokens, so it clears 4.5:1
 * on its own tint in both themes.
 */
export function InlineAlert({
  tone = "danger",
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "rounded-md px-3 py-2 text-sm",
        tone === "danger" && "bg-danger/15 text-danger-ink",
        tone === "warning" && "bg-warning/15 text-warning-ink",
        tone === "success" && "bg-success/15 text-success-ink",
        tone === "neutral" && "bg-well text-ink-secondary",
        className,
      )}
    >
      {children}
    </p>
  );
}
