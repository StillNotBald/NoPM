import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/**
 * Issues loading skeleton — mirrors Issue Log layout:
 * page header · issues table
 */
export default function IssuesLoading() {
  return (
    <PageContainer className="space-y-5">
      <div className="space-y-5">
        {/* page header */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-28" height="h-7" />
          <Skeleton variant="rect" width="w-24" height="h-9" />
        </div>

        {/* issue table: ref, title, project, severity, priority, status, owner, due */}
        <TableSkeleton rows={8} cols={8} />
      </div>
    </PageContainer>
  );
}
