import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/** Approvals loading skeleton: header · callout · filter · request table. */
export default function ApprovalsLoading() {
  return (
    <PageContainer width="narrow" className="space-y-6">
      <Skeleton variant="text" width="w-28" height="h-7" />
      <Skeleton variant="rect" width="w-full" height="h-10" />
      <Skeleton variant="rect" width="w-64" height="h-8" />
      <TableSkeleton rows={5} cols={4} />
    </PageContainer>
  );
}
