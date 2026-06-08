import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/**
 * Severity / priority "heat" indicator — a small coloured DOT + plain label.
 *
 * Intentionally distinct from <Badge> (filled status pills): urgency reads as a
 * heat ramp where only the dot carries colour, so it never competes with the
 * filled status pills sitting next to it.
 *
 * Accepts both severity values ("low" | "medium" | "high" | "critical") and
 * priority values ("low" | "medium" | "high" | "urgent").
 */

export type SeverityLevel =
  | "low"
  | "medium"
  | "high"
  | "critical"
  | "urgent";

// Heat ramp — only the dot carries colour.
const dotColour: Record<SeverityLevel, string> = {
  critical: "text-danger",          // red
  urgent: "text-danger",            // red (priority equivalent of critical)
  high: "text-[#ea580c]",           // clear orange
  medium: "text-warning",           // amber
  low: "text-ink-muted",            // grey
};

const labelText: Record<SeverityLevel, string> = {
  critical: "Critical",
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export function Severity({
  level,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { level: SeverityLevel | (string & {}) }) {
  const key = (level as string).toLowerCase() as SeverityLevel;
  const colour = dotColour[key] ?? "text-ink-muted";
  const label = labelText[key] ?? (level as string);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn("text-[8px] leading-none", colour)}
      >
        ●
      </span>
      <span className="text-ink-secondary">{label}</span>
    </span>
  );
}
