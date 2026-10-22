import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Native <details> disclosure (keyboard + screen-reader support for free), collapsed by default.
 * The body sets a muted small text default so bare <p> children match the surrounding copy.
 */
export function Disclosure({
  summary,
  children,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={cn("group rounded-md border border-border-subtle bg-surface", className)}>
      <summary className="focus-ring flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-2 rounded-md px-3 py-2 text-sm font-medium text-ink marker:hidden [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">{summary}</span>
        <ChevronDown
          size={16}
          className="shrink-0 text-ink-muted transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-3 border-t border-border-subtle px-3 py-3 text-sm text-ink-secondary">{children}</div>
    </details>
  );
}
