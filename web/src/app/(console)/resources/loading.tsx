import { StatGridSkeleton, TableSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/**
 * Resources loading skeleton — mirrors Resources layout:
 * page header · capacity KPI row · team member table
 */
export default function ResourcesLoading() {
  return (
    <PageContainer className="space-y-6">
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-28" height="h-7" />
          <Skeleton variant="rect" width="w-28" height="h-9" />
        </div>
        <StatGridSkeleton count={4} />
        <TableSkeleton rows={8} cols={6} />
      </div>
    </PageContainer>
  );
}
