import { cn } from "@/lib/cn";

// ── Skeleton primitive ────────────────────────────────────────────────────────

type SkeletonVariant = "text" | "rect" | "circle";

interface SkeletonProps {
  variant?: SkeletonVariant;
  /** Tailwind width utility or arbitrary value, e.g. "w-32" or "w-[120px]" */
  width?: string;
  /** Tailwind height utility or arbitrary value, e.g. "h-4" or "h-[18px]" */
  height?: string;
  className?: string;
}

/**
 * Base skeleton shimmer block. Uses bg-sunken + animate-pulse.
 * variant="text"   → rounded-full, h-4, full width by default
 * variant="rect"   → rounded-md
 * variant="circle" → rounded-full + equal w/h
 */
export function Skeleton({
  variant = "rect",
  width,
  height,
  className,
}: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-pulse bg-sunken motion-reduce:animate-none",
        variant === "text" && "h-4 rounded-full",
        variant === "rect" && "rounded-md",
        variant === "circle" && "rounded-full",
        width ?? (variant === "circle" ? "w-8" : "w-full"),
        height ?? (variant === "circle" ? "h-8" : variant === "text" ? "h-4" : "h-10"),
        className,
      )}
      aria-hidden="true"
    />
  );
}

// ── Compound skeletons ────────────────────────────────────────────────────────

/**
 * Table skeleton — renders `rows` rows × `cols` columns inside a card-style border.
 */
export function TableSkeleton({
  rows = 6,
  cols = 5,
  className,
}: {
  rows?: number;
  cols?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border-subtle bg-surface",
        className,
      )}
      aria-hidden="true"
    >
      {/* header row */}
      <div className="border-b border-border-subtle px-5 py-3">
        <div className="flex items-center gap-4">
          {Array.from({ length: cols }).map((_, i) => (
            <Skeleton key={i} variant="text" width="w-16" height="h-3" />
          ))}
        </div>
      </div>
      {/* data rows */}
      <div className="divide-y divide-border-subtle">
        {Array.from({ length: rows }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 px-5 py-3.5">
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton
                key={c}
                variant="text"
                // vary widths to feel more natural
                width={c === 0 ? "w-14" : c === 1 ? "w-40" : c === cols - 1 ? "w-20" : "w-24"}
                height="h-4"
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Card skeleton — single card with a header strip + body content lines.
 */
export function CardSkeleton({
  lines = 4,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border-subtle bg-surface",
        className,
      )}
      aria-hidden="true"
    >
      {/* card header */}
      <div className="flex items-center justify-between border-b border-border-subtle px-5 py-4">
        <Skeleton variant="text" width="w-32" height="h-4" />
        <Skeleton variant="text" width="w-16" height="h-3" />
      </div>
      {/* body */}
      <div className="space-y-3 px-5 py-5">
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton
            key={i}
            variant="text"
            width={i === lines - 1 ? "w-3/5" : "w-full"}
            height="h-4"
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Stat grid skeleton — matches the KPI strip pattern (N equal-width stat cards).
 */
export function StatGridSkeleton({
  count = 4,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-4",
        count === 2 && "grid-cols-2",
        count === 3 && "grid-cols-3",
        count === 4 && "grid-cols-2 lg:grid-cols-4",
        count === 5 && "grid-cols-2 lg:grid-cols-5",
        count === 6 && "grid-cols-2 lg:grid-cols-6",
        !(count >= 2 && count <= 6) && "grid-cols-2 lg:grid-cols-4",
        className,
      )}
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-lg border border-border-subtle bg-surface px-5 py-4 space-y-3"
        >
          <Skeleton variant="text" width="w-20" height="h-3" />
          <Skeleton variant="text" width="w-14" height="h-7" />
        </div>
      ))}
    </div>
  );
}
