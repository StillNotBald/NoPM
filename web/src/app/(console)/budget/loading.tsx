import { StatGridSkeleton, TableSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Budget loading skeleton — mirrors Budget layout:
 * page header · summary KPI strip · budget table with EVM columns
 */
export default function BudgetLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* page header */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-24" height="h-7" />
        </div>

        {/* budget summary KPIs */}
        <StatGridSkeleton count={4} />

        {/* budget table: project, planned, committed, actual, variance, burn, CPI, SPI */}
        <TableSkeleton rows={7} cols={8} />
      </div>
    </div>
  );
}
