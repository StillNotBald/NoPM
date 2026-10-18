import { PageContainer } from "@/components/ui/page-container";
import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Change Control loading skeleton — mirrors Change Control layout:
 * page header · change requests table
 */
export default function ChangeControlLoading() {
  return (
    <PageContainer className="space-y-6">
      <div className="space-y-6">
        {/* page header */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-36" height="h-7" />
          <Skeleton variant="rect" width="w-28" height="h-9" />
        </div>

        {/* change requests table: ref, title, project, impact, priority, status, requested by, date */}
        <TableSkeleton rows={7} cols={8} />
      </div>
    </PageContainer>
  );
}
