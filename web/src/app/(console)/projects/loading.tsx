import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/** Projects loading skeleton: header, toolbar row, table. */
export default function ProjectsLoading() {
  return (
    <PageContainer className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Skeleton variant="text" width="w-24" height="h-7" />
        <Skeleton variant="rect" width="w-28" height="h-9" />
      </div>
      <Skeleton variant="rect" width="w-full" height="h-9" />
      <TableSkeleton rows={8} cols={6} />
    </PageContainer>
  );
}
