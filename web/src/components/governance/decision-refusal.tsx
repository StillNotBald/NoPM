"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import type { Refusal } from "./refusal";

/**
 * A refused decision, shown INSTEAD of the confirm form (never stacked above
 * a still-enabled "Confirm" bar). It takes focus on mount so a screen-reader
 * or keyboard user lands on the reason, and it is a live alert for the same
 * reason. `stale` refusals (already decided, changed since opened) offer a
 * refresh; every refusal offers a way back.
 */
export function DecisionRefusal({
  refusal,
  onBack,
  onRefresh,
  className,
}: {
  refusal: Refusal;
  onBack: () => void;
  onRefresh?: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      className={cn("space-y-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-3 focus:outline-none", className)}
    >
      <div className="space-y-1">
        <p className="text-sm font-semibold text-danger-ink">{refusal.title}</p>
        <p className="text-sm text-ink-secondary">{refusal.detail}</p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        {refusal.stale && onRefresh && (
          <Button type="button" variant="primary" size="sm" className="h-11 w-full sm:h-8 sm:w-auto" onClick={onRefresh}>
            Refresh
          </Button>
        )}
        <Button type="button" variant="secondary" size="sm" className="h-11 w-full sm:h-8 sm:w-auto" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}
