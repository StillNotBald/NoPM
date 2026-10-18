import { StatGridSkeleton, CardSkeleton, TableSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Dashboard loading skeleton — mirrors Dashboard layout:
 * page header · KPI strip (8 stats) · 2-col chart row · portfolio table
 */
export default function DashboardLoading() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      {/* page header */}
      <div className="flex items-center justify-between gap-3">
        <Skeleton variant="text" width="w-44" height="h-7" />
        <Skeleton variant="rect" width="w-32" height="h-9" />
      </div>

      {/* KPI strip — 8 stats */}
      <StatGridSkeleton count={8} />

      {/* charts row */}
      <div className="grid gap-4 lg:grid-cols-2">
        <CardSkeleton lines={6} />
        <CardSkeleton lines={6} />
      </div>

      {/* portfolio table */}
      <TableSkeleton rows={8} cols={8} />
    </div>
  );
}
