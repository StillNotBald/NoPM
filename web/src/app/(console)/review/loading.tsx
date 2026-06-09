import { CardSkeleton, StatGridSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Review loading skeleton — mirrors Review layout:
 * page header · summary stats · review cards grid
 */
export default function ReviewLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* page header */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-24" height="h-7" />
        </div>

        {/* summary stats */}
        <StatGridSkeleton count={4} />

        {/* review cards */}
        <div className="grid gap-4 md:grid-cols-2">
          <CardSkeleton lines={5} />
          <CardSkeleton lines={5} />
          <CardSkeleton lines={5} />
          <CardSkeleton lines={5} />
        </div>
      </div>
    </div>
  );
}
