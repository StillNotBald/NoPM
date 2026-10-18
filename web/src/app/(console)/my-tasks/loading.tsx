import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/** My Tasks loading skeleton: header, assigned-task table. */
export default function MyTasksLoading() {
  return (
    <PageContainer className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Skeleton variant="text" width="w-28" height="h-7" />
      </div>
      <TableSkeleton rows={6} cols={4} />
    </PageContainer>
  );
}
