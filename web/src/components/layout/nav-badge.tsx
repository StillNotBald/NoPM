import { cn } from "@/lib/cn";
import { pendingSrText } from "@/lib/nav/nav-config";

/**
 * Pending-decision count pill for nav items / groups. Visual text is the
 * (capped) number; screen readers get "N items awaiting your decision" for
 * someone who can decide, and "N items in review" for everyone else (UAT-031).
 * Renders nothing for 0 so a quiet queue adds no chrome.
 */
export function NavBadge({ count, className, canDecide = true }: { count: number; className?: string; canDecide?: boolean }) {
  if (!count || count < 1) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-[1.25rem] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-semibold leading-5 text-accent-ink",
        className,
      )}
    >
      <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
      <span className="sr-only">{pendingSrText(count, canDecide)}</span>
    </span>
  );
}
