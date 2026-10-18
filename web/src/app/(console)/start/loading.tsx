import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * /start loading skeleton — mirrors the page layout: page header · 3-tile
 * "how it works" strip · checklist card · quickstart card.
 */
export default function StartLoading() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      {/* page header */}
      <Skeleton variant="text" width="w-40" height="h-7" />

      {/* how-it-works tile strip */}
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-border-subtle bg-surface p-4 space-y-2">
            <Skeleton variant="circle" width="w-5" height="h-5" />
            <Skeleton variant="text" width="w-24" height="h-4" />
            <Skeleton variant="text" width="w-full" height="h-3" />
          </div>
        ))}
      </div>

      {/* checklist card */}
      <CardSkeleton lines={5} />

      {/* quickstart card */}
      <CardSkeleton lines={4} />
    </div>
  );
}
