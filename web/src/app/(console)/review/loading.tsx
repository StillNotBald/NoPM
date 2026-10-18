import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/** Review loading skeleton: header · queue callout · list of review cards. */
export default function ReviewLoading() {
  return (
    <PageContainer width="narrow" className="space-y-6">
      <Skeleton variant="text" width="w-32" height="h-7" />
      <Skeleton variant="rect" width="w-full" height="h-10" />
      <div className="space-y-4">
        <CardSkeleton lines={3} />
        <CardSkeleton lines={3} />
        <CardSkeleton lines={3} />
      </div>
    </PageContainer>
  );
}
