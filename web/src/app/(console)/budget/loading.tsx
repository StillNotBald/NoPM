import { StatGridSkeleton, TableSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/**
 * Budget loading skeleton — mirrors Budget layout:
 * page header · KPI row · budget table with pacing column
 */
export default function BudgetLoading() {
  return (
    <PageContainer className="space-y-6">
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-24" height="h-7" />
          <Skeleton variant="rect" width="w-28" height="h-9" />
        </div>
        <StatGridSkeleton count={5} />
        <TableSkeleton rows={7} cols={6} />
      </div>
    </PageContainer>
  );
}
