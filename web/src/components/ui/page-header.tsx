import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Compact one-row page header: title on the left, action(s) on the right —
 * same row on every breakpoint. No subtitle (keep pages dense).
 */
export function PageHeader({
  title,
  action,
  className,
}: {
  title: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-5 flex items-center justify-between gap-3", className)}>
      <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight text-ink sm:text-xl">
        {title}
      </h1>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}
