"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RotateCw } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * L-34 — per-card "last refreshed" stamp + manual refresh button.
 *
 * `fetchedAt` is the DATA fetch time, stamped once server-side right after
 * the dashboard RSC's Promise.all resolves (NOT render time) and threaded
 * down as a prop — every card on the page shares one fetch, so one
 * timestamp is honest for all of them.
 *
 * The refresh BUTTON is interactive chrome and is hidden from print
 * (`print:hidden`); the TIMESTAMP TEXT is not hidden by any responsive/print
 * class, so it survives into print/export output.
 */
export function CardFreshness({ fetchedAt, className }: { fetchedAt: string; className?: string }) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);

  const stamp = new Date(fetchedAt).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  function refresh() {
    setRefreshing(true);
    router.refresh();
    // router.refresh() re-renders the RSC in place — there's no promise to
    // await here, so drop the spinner after a short, purely-cosmetic delay.
    setTimeout(() => setRefreshing(false), 600);
  }

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <span className="font-mono text-xs text-ink-muted tabular-nums" title={new Date(fetchedAt).toLocaleString("en-US")}>
        Updated {stamp}
      </span>
      <button
        type="button"
        onClick={refresh}
        disabled={refreshing}
        aria-label="Refresh data"
        title="Refresh data"
        className={cn(
          // >=44px touch target at 390px (R-63); shrinks back to a normal
          // dense icon-button size at sm+ where a mouse pointer is assumed.
          "print:hidden grid h-11 w-11 sm:h-[26px] sm:w-[26px] shrink-0 place-items-center rounded text-ink-muted",
          "hover:bg-sunken hover:text-ink transition-colors duration-150",
          "disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
        )}
      >
        <RotateCw size={11} className={cn(refreshing && "animate-spin")} />
      </button>
    </div>
  );
}
