import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/** Tasks loading skeleton: header, filter strip, task table. */
export default function TasksLoading() {
  return (
    <PageContainer width="wide" className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Skeleton variant="text" width="w-20" height="h-7" />
        <Skeleton variant="rect" width="w-28" height="h-9" />
      </div>
      <TableSkeleton rows={8} cols={5} />
    </PageContainer>
  );
}
