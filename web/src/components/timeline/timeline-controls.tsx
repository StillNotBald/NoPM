"use client";

import { cn } from "@/lib/cn";

/**
 * "Today" and "Fit" controls for a time-axis view. Pair with
 * useTimelineViewport. Both are real buttons (44px below sm) and neither
 * changes data: Today scrolls the window, Fit rescales px-per-day so the whole
 * range fits the window.
 */
export function TimelineControls({
  onToday,
  todayAvailable,
  fit,
  onFitChange,
  className,
}: {
  onToday: () => void;
  /** False when today lies outside the plotted range. */
  todayAvailable: boolean;
  fit: boolean;
  onFitChange: (fit: boolean) => void;
  className?: string;
}) {
  const base =
    "focus-ring inline-flex min-h-[44px] items-center rounded-md border border-border-subtle bg-surface px-3 text-xs font-medium text-ink hover:bg-well sm:min-h-[36px]";
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <button
        type="button"
        onClick={onToday}
        disabled={!todayAvailable}
        title={todayAvailable ? "Scroll to today" : "Today is outside this date range"}
        className={cn(base, "disabled:pointer-events-none disabled:opacity-50")}
      >
        Today
      </button>
      <button
        type="button"
        onClick={() => onFitChange(!fit)}
        aria-pressed={fit}
        title="Fit the whole date range to the window"
        className={cn(base, fit && "border-border-strong bg-well")}
      >
        Fit
      </button>
    </div>
  );
}
