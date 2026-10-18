import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/** Email previews loading skeleton: header, preview cards. */
export default function EmailPreviewsLoading() {
  return (
    <PageContainer className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Skeleton variant="text" width="w-36" height="h-7" />
      </div>
      <CardSkeleton lines={3} />
      <CardSkeleton lines={3} />
    </PageContainer>
  );
}
