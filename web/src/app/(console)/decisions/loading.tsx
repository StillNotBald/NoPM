import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/** Decision Log loading skeleton: header · callout · filter · decisions table. */
export default function DecisionsLoading() {
  return (
    <PageContainer width="narrow" className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Skeleton variant="text" width="w-32" height="h-7" />
        <Skeleton variant="rect" width="w-28" height="h-9" />
      </div>
      <Skeleton variant="rect" width="w-full" height="h-10" />
      <Skeleton variant="rect" width="w-72" height="h-8" />
      <TableSkeleton rows={7} cols={6} />
    </PageContainer>
  );
}
