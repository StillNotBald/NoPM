import { StatGridSkeleton, TableSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Resources loading skeleton — mirrors Resources layout:
 * page header · capacity stats · team member table
 */
export default function ResourcesLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* page header */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-28" height="h-7" />
          <Skeleton variant="rect" width="w-28" height="h-9" />
        </div>

        {/* capacity KPI strip */}
        <StatGridSkeleton count={4} />

        {/* team / allocation table */}
        <TableSkeleton rows={8} cols={6} />
      </div>
    </div>
  );
}
