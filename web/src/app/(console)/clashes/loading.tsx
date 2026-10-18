import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/**
 * Clashes loading skeleton — mirrors Clashes layout:
 * page header · clashes table
 */
export default function ClashesLoading() {
  return (
    <PageContainer className="space-y-5">
      <div className="space-y-5">
        {/* page header */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-20" height="h-7" />
          <Skeleton variant="rect" width="w-28" height="h-9" />
        </div>

        {/* clashes table: ref, type, projects, severity, status, raised */}
        <TableSkeleton rows={7} cols={6} />
      </div>
    </PageContainer>
  );
}
