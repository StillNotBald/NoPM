import { CardSkeleton, StatGridSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * My Work loading skeleton — mirrors My Work hub layout:
 * page header · stat strip · grouped task/action cards
 */
export default function MyWorkLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* page header */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-24" height="h-7" />
        </div>

        {/* stat strip */}
        <StatGridSkeleton count={4} />

        {/* task / action cards */}
        <div className="space-y-4">
          <CardSkeleton lines={4} />
          <CardSkeleton lines={4} />
          <CardSkeleton lines={3} />
        </div>
      </div>
    </div>
  );
}
